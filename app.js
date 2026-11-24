// 1. Initialize MapLibre with free OpenFreeMap vector tiles (no API token required)
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [28.31, -15.42], // Lusaka: [longitude, latitude]
  zoom: 12,
  attributionControl: false
});

map.addControl(
  new maplibregl.AttributionControl({
    compact: false,
    customAttribution: [
      'Data: <a href="https://gitlab.com/digitaltransport/data/africa/lusaka" target="_blank" rel="noopener noreferrer">Digital Transport for Africa</a>',
      'Created by <a href="https://jedidiahchibinga.wixsite.com/jedidiah-chibinga" target="_blank" rel="noopener noreferrer">Jedidiah Chibinga</a>'
    ]
  }),
  'bottom-right'
);


map.addControl(new maplibregl.NavigationControl(), 'top-right');

let tripsData = null;
let stopsData = null;
let routeStopIndex = []; // Precomputed stop positions along each route
let stopsByName = new Map(); // Lookup map for stop autocomplete

let originCoord = null;
let destCoord = null;
let activePopup = null;
let handledLayerClick = false;
let originMarker = null;
let destMarker = null;

const loaderOverlay = document.getElementById('loader-overlay');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const originInput = document.getElementById('origin-input');
const destInput = document.getElementById('dest-input');
const stopsDatalist = document.getElementById('stops-datalist');
const sidebarEl = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');

toggleSidebarBtn.addEventListener('click', () => {
  sidebarEl.classList.toggle('collapsed');
});


// 2A. Load local GeoJSON files once map loads
map.on('load', async () => {
  try {
    const [tripsRes, stopsRes] = await Promise.all([
      fetch('./data/processed_trips.geojson'),
      fetch('./data/processed_stops.geojson')
    ]);
    tripsData = await tripsRes.json();
    stopsData = await stopsRes.json();    
    
    populateStopAutocomplete();
    buildRouteStopIndex();
    initMapLayers();
    initPopups();

    loaderOverlay.classList.add('hidden');

    statusEl.textContent = 'Type a stop or click map.';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error loading GeoJSON. Run via a local server (e.g., VS Code Live Server or python -m http.server).';
  }
});


// 2B. Populate autocomplete datalist with unique stop names
function populateStopAutocomplete() {
  const uniqueNames = new Set();
  for (const stop of stopsData.features) {
    if (!stop.geometry || stop.geometry.type !== 'Point' || !stop.properties.name) continue;
    const name = stop.properties.name.trim();
    if (!name) continue;
    if (!stopsByName.has(name.toLowerCase())) {
      stopsByName.set(name.toLowerCase(), stop.geometry.coordinates);
    }
    uniqueNames.add(name);
  }

  const sortedNames = Array.from(uniqueNames).sort((a, b) => a.localeCompare(b));
  const fragment = document.createDocumentFragment();
  for (const name of sortedNames) {
    const option = document.createElement('option');
    option.value = name;
    fragment.appendChild(option);
  }
  stopsDatalist.appendChild(fragment);
}

// 3. Precompute which stops lie within 300m of each route and their distance along the route
// + Filter which stops physically sit on the correct side of each route
function buildRouteStopIndex() {
  const maxSnapKm = 0.005; // 5 meters max distance from the route centerline

  routeStopIndex = tripsData.features
    .filter(f => f.geometry && f.geometry.type === 'LineString')
    .map(trip => {
      const totalLenKm = turf.length(trip, { units: 'kilometers' });
      const snappedStops = [];

      for (const stop of stopsData.features) {
        if (!stop.geometry || stop.geometry.type !== 'Point') continue;

        const snapped = turf.nearestPointOnLine(trip, stop, { units: 'kilometers' });
        if (snapped.properties.dist > maxSnapKm) continue;

        // Check side of road (Zambia drives on the LEFT):
        // Compare route travel bearing at the snapped point vs. bearing from line to stop
        const loc = snapped.properties.location;
        const p1 = turf.along(trip, Math.max(0, loc - 0.02), { units: 'kilometers' });
        const p2 = turf.along(trip, Math.min(totalLenKm, loc + 0.02), { units: 'kilometers' });

        const routeBearing = turf.bearing(p1, p2);
        const stopBearing = turf.bearing(snapped, stop);

        // Normalize relative angle to [-180, +180]: negative = left side, positive = right side
        let relAngle = ((stopBearing - routeBearing + 540) % 360) - 180;

        // Keep stops very close to centerline (<12m, e.g. terminals) OR on the left side of the road
        if (snapped.properties.dist <= 0.012 || relAngle <= 15) {
          snappedStops.push({
            gid: stop.properties.gid,
            name: stop.properties.name,
            coord: stop.geometry.coordinates,
            locationKm: loc
          });
        }
      }

      snappedStops.sort((a, b) => a.locationKm - b.locationKm);
      return { trip, stops: snappedStops };
    });
}

// 4. Add background network layers, walking connectors, and highlighted itinerary layers
function initMapLayers() {
  map.addSource('all-trips', { type: 'geojson', data: tripsData });
  map.addSource('all-stops', { type: 'geojson', data: stopsData });
  map.addSource('walk-routes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addSource('selected-route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addSource('selected-stops', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });


  // Faint background routes
  map.addLayer({
    id: 'all-trips-layer',
    type: 'line',
    source: 'all-trips',
    paint: {
      'line-color': '#94a3b8',
      'line-width': 3,
      'line-opacity': 0.8
    }
  });

  // Bus stops (visible at all zooms and slightly larger for easy clicking)
  map.addLayer({
    id: 'all-stops-layer',
    type: 'circle',
    source: 'all-stops',
    paint: {
      'circle-radius': 2.5,
      'circle-color': '#475569',
      'circle-stroke-width': 1.0,
      'circle-stroke-color': '#ffffff'
    }
  });

  // Dashed walking lines (Origin -> Boarding Stop & Alighting Stop -> Destination)
  map.addLayer({
    id: 'walk-routes-layer',
    type: 'line',
    source: 'walk-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#334155',
      'line-width': 3.5,
      'line-dasharray': [2, 2]
    }
  });

  // Highlighted active journey (Trip 1 = Blue, Trip 2 = Orange)
  map.addLayer({
    id: 'selected-route-layer',
    type: 'line',
    source: 'selected-route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'leg'], 1, '#2563eb', 2, '#ea580c', '#2563eb'],
      'line-width': 6
    }
  });
  map.addLayer({
    id: 'selected-stops-layer',
    type: 'circle',
    source: 'selected-stops',
    paint: {
      'circle-radius': ['match', ['get', 'role'], 'board', 7, 'alight', 7, 'transfer', 7, 4.5],
      'circle-color': [
        'match',
        ['get', 'role'],
        'board', '#16a34a',    // Green for boarding stop
        'transfer', '#575757', // Orange for transfer stop
        'alight', '#dc2626',   // Red for alighting stop
        '#ffffff'              // White dot for intermediate stops
      ],
      'circle-stroke-width': 2.5,
      'circle-stroke-color': [
        'match',
        ['get', 'role'],
        'board', '#ffffff',
        'transfer', '#ffffff',
        'alight', '#ffffff',
        '#1e3a8a'              // Dark blue ring on intermediate stops
      ]
    }
  });

  map.addLayer({
    id: 'selected-stops-labels',
    type: 'symbol',
    source: 'selected-stops',
    filter: ['in', ['get', 'role'], ['literal', ['board', 'transfer', 'alight']]],
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 12,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-font': ['Noto Sans Bold']
    },
    paint: {
      'text-color': '#111827',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2
    }
  });

}

// 4B. Interactive Popups when clicking Bus Stops or Routes
function initPopups() {
  ['all-stops-layer', 'all-trips-layer', 'selected-route-layer'].forEach(layerId => {
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  });

  // 1. Click on a Bus Stop -> Show name, serving routes, and "Go here" button
  map.on('click', 'all-stops-layer', (e) => {
    handledLayerClick = true;
    const feature = e.features[0];
    const coords = feature.geometry.coordinates.slice();
    const stopGid = feature.properties.gid;
    const stopName = feature.properties.name || 'Unnamed Bus Stop';

    const servingRoutes = Array.from(new Set(
      routeStopIndex
        .filter(entry => entry.stops.some(s => s.gid === stopGid || s.name === stopName))
        .map(entry => entry.trip.properties.route_long)
        .filter(Boolean)
    )).sort();

    const routesHtml = servingRoutes.length
      ? '<ul class="popup-route-list">' + servingRoutes.map(r => '<li>' + r + '</li>').join('') + '</ul>'
      : '<div class="popup-sub">No mapped routes within 300m</div>';

    if (activePopup) activePopup.remove();

    const container = document.createElement('div');
    container.innerHTML =
      '<div class="popup-title">' + stopName + '</div>' +
      '<div class="popup-sub"><strong>Bus routes (' + servingRoutes.length + '):</strong></div>' +
      routesHtml +
      '<div class="popup-actions">' +
        '<button type="button" class="popup-btn dest go-here-btn">Go here</button>' +
      '</div>';

    container.querySelector('.go-here-btn').addEventListener('click', () => {
      setDestination(coords, stopName);
      activePopup.remove();
    });

    activePopup = new maplibregl.Popup({ offset: 12, maxWidth: '280px' })
      .setLngLat(coords)
      .setDOMContent(container)
      .addTo(map);
  });

  // 2. Click on a Bus Route Line -> Show route name, bus type, fare, and length
  map.on('click', 'all-trips-layer', (e) => {
    if (handledLayerClick) return;
    handledLayerClick = true;

    const props = e.features[0].properties;
    if (activePopup) activePopup.remove();

    const html =
      '<div class="popup-title">' + (props.route_long || 'Bus Route') + '</div>' +
      '<div class="popup-sub">' +
        '<strong>Bus:</strong> ' + (props.vehicle_name || 'N/A') + ' (' + (props.passenger_capacity || 'N/A') + ')<br/>' +
        '<strong>Fare:</strong> ZMW ' + (props.fare || 'N/A') + '<br/>' +
        '<strong>Length:</strong> ' + (props.len_km ? Number(props.len_km).toFixed(1) + ' km' : 'N/A') +
      '</div>';

    activePopup = new maplibregl.Popup({ offset: 8 })
      .setLngLat(e.lngLat)
      .setHTML(html)
      .addTo(map);
  });
}

// Helper functions to set Origin / Destination from either map click or text input
function setOrigin(lngLat, labelText) {
  originCoord = lngLat;
  if (originMarker) originMarker.remove();
  originMarker = new maplibregl.Marker({ color: '#16a34a' }).setLngLat(lngLat).addTo(map);
  originInput.value = labelText || (lngLat[0].toFixed(5) + ', ' + lngLat[1].toFixed(5));

  if (destCoord) {
    findRoutes(originCoord, destCoord);
  } else {
    resultsEl.innerHTML = '';
    clearHighlightedRoute();
    statusEl.textContent = 'Select a Destination stop or click on the map (B).';
  }
}

function setDestination(lngLat, labelText) {
  destCoord = lngLat;
  if (destMarker) destMarker.remove();
  destMarker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat(lngLat).addTo(map);
  destInput.value = labelText || (lngLat[0].toFixed(5) + ', ' + lngLat[1].toFixed(5));

  if (originCoord) {
    findRoutes(originCoord, destCoord);
  } else {
    statusEl.textContent = 'Select an Origin stop or click on the map (A).';
  }
}

// 5A. Handle stop selection from autocomplete inputs
originInput.addEventListener('change', () => {
  const val = originInput.value.trim();
  const match = stopsByName.get(val.toLowerCase());
  if (match) {
    setOrigin(match, val);
    map.flyTo({ center: match, zoom: 14 });
  }
});

destInput.addEventListener('change', () => {
  const val = destInput.value.trim();
  const match = stopsByName.get(val.toLowerCase());
  if (match) {
    setDestination(match, val);
    if (!originCoord) map.flyTo({ center: match, zoom: 14 });
  }
});

// 5B. Handle map clicks to set Origin (A) and Destination (B)
map.on('click', (e) => {
  if (handledLayerClick) {
    handledLayerClick = false;
    return;
  }
  if (!routeStopIndex.length) return;
  const lngLat = [e.lngLat.lng, e.lngLat.lat];

  if (!originCoord || (originCoord && destCoord)) {
    destCoord = null;
    if (destMarker) destMarker.remove();
    destInput.value = '';
    setOrigin(lngLat);
  } else {
    setDestination(lngLat);
  }
});

document.getElementById('reset-btn').addEventListener('click', () => {
  originCoord = null;
  destCoord = null;
  if (originMarker) originMarker.remove();
  if (destMarker) destMarker.remove();
  originInput.value = '';
  destInput.value = '';
  resultsEl.innerHTML = '';
  clearHighlightedRoute();
  statusEl.textContent = 'Type a stop or click map to set Origin (A).';
});

document.getElementById('swap-btn').addEventListener('click', () => {
  if (!originCoord && !destCoord) return;

  // 1. Swap coordinates and input values
  const tempCoord = originCoord;
  const tempLabel = originInput.value;

  originCoord = destCoord;
  originInput.value = destInput.value;

  destCoord = tempCoord;
  destInput.value = tempLabel;

  // 2. Re-render markers with updated colors (Origin = Green, Dest = Red)
  if (originMarker) originMarker.remove();
  if (destMarker) destMarker.remove();
  originMarker = null;
  destMarker = null;

  if (originCoord) {
    originMarker = new maplibregl.Marker({ color: '#16a34a' }).setLngLat(originCoord).addTo(map);
  }
  if (destCoord) {
    destMarker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat(destCoord).addTo(map);
  }

  // 3. Recompute routes or update prompt status
  if (originCoord && destCoord) {
    findRoutes(originCoord, destCoord);
  } else if (originCoord) {
    resultsEl.innerHTML = '';
    clearHighlightedRoute();
    statusEl.textContent = 'Now select a Destination stop or click on the map (B).';
  } else {
    resultsEl.innerHTML = '';
    clearHighlightedRoute();
    statusEl.textContent = 'Now select an Origin stop or click on the map (A).';
  }
});

const locateBtn = document.getElementById('locate-btn');

locateBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation is not supported by your browser.';
    return;
  }

  locateBtn.disabled = true;
  statusEl.textContent = 'Detecting your GPS location...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locateBtn.disabled = false;
      const lngLat = [pos.coords.longitude, pos.coords.latitude];

      // Check if user is within Greater Lusaka bounds (~28.0–28.6 E, -15.6 to -15.2 S)
      const inLusaka = lngLat[0] >= 28.0 && lngLat[0] <= 28.6 && lngLat[1] >= -15.6 && lngLat[1] <= -15.2;

      setOrigin(lngLat, 'My Current Location');
      map.flyTo({ center: lngLat, zoom: 14 });

      if (!inLusaka) {
        statusEl.textContent = 'GPS detected outside Lusaka—no local bus stops within 800m.';
      }
    },
    (err) => {
      locateBtn.disabled = false;
      if (err.code === err.PERMISSION_DENIED) {
        statusEl.textContent = 'Location permission denied. Please allow location access or click the map.';
      } else {
        statusEl.textContent = 'Unable to get GPS location. Try clicking on the map instead.';
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
});


function clearHighlightedRoute() {
  const routeSrc = map.getSource('selected-route');
  const walkSrc = map.getSource('walk-routes');
  const stopsSrc = map.getSource('selected-stops');
  if (routeSrc) routeSrc.setData({ type: 'FeatureCollection', features: [] });
  if (walkSrc) walkSrc.setData({ type: 'FeatureCollection', features: [] });
  if (stopsSrc) stopsSrc.setData({ type: 'FeatureCollection', features: [] });
}

// 6. Find Direct (0-transfer) and 1-Transfer bus itineraries
function findRoutes(orig, dest) {
  const origPt = turf.point(orig);
  const destPt = turf.point(dest);
  const maxWalkKm = 0.8; // 800m max walk to/from stop

  const boardOptions = [];
  const alightOptions = [];

  for (const entry of routeStopIndex) {
    let bestBoard = null;
    let bestAlight = null;

    for (const s of entry.stops) {
      const dOrig = turf.distance(origPt, turf.point(s.coord), { units: 'kilometers' });
      if (dOrig <= maxWalkKm && (!bestBoard || dOrig < bestBoard.walkKm)) {
        bestBoard = { ...s, walkKm: dOrig };
      }
      const dDest = turf.distance(destPt, turf.point(s.coord), { units: 'kilometers' });
      if (dDest <= maxWalkKm && (!bestAlight || dDest < bestAlight.walkKm)) {
        bestAlight = { ...s, walkKm: dDest };
      }
    }

    if (bestBoard) boardOptions.push({ entry, stop: bestBoard });
    if (bestAlight) alightOptions.push({ entry, stop: bestAlight });
  }

  const itineraries = [];

  // A. Check Direct Routes
  for (const b of boardOptions) {
    for (const a of alightOptions) {
      if (b.entry.trip.properties.gid === a.entry.trip.properties.gid && b.stop.locationKm < a.stop.locationKm) {
        const segment = turf.lineSliceAlong(b.entry.trip, b.stop.locationKm, a.stop.locationKm, { units: 'kilometers' });
        segment.properties = { leg: 1 };
        const stopsInRange = b.entry.stops.filter(
          s => s.locationKm >= b.stop.locationKm && s.locationKm <= a.stop.locationKm
        );
        const stopsBetween = stopsInRange.map(s => s.name);

        const stopFeatures = stopsInRange.map((s, idx) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: s.coord },
          properties: {
            name: s.name,
            role: idx === 0 ? 'board' : (idx === stopsInRange.length - 1 ? 'alight' : 'intermediate')
          }
        }));


        const walkFeatures = [];
        if (b.stop.walkKm > 0.01) walkFeatures.push(turf.lineString([orig, b.stop.coord]));
        if (a.stop.walkKm > 0.01) walkFeatures.push(turf.lineString([a.stop.coord, dest]));

        itineraries.push({transfers: 0,
          walkKm: b.stop.walkKm + a.stop.walkKm,
          boardWalkKm: b.stop.walkKm,
          xferWalkKm: 0,
          alightWalkKm: a.stop.walkKm,
          fare: b.entry.trip.properties.fare || 0,
          legs: [{
            route: b.entry.trip.properties.route_long,
            bus: b.entry.trip.properties.vehicle_name,
            capacity: b.entry.trip.properties.passenger_capacity,
            board: b.stop.name,
            alight: a.stop.name,
            stops: stopsBetween
          }],
          features: [segment],
          walkFeatures: walkFeatures,
          stopFeatures: stopFeatures
        });
      }
    }
  }

  // B. Check 1-Transfer Routes if few/no direct routes exist
  if (itineraries.length < 3) {
    for (const b of boardOptions) {
      for (const a of alightOptions) {
        if (b.entry.trip.properties.gid === a.entry.trip.properties.gid) continue;

        // Find shared or nearby (<200m) transfer stop
        for (const s1 of b.entry.stops) {
          if (s1.locationKm <= b.stop.locationKm) continue;
          for (const s2 of a.entry.stops) {
            if (s2.locationKm >= a.stop.locationKm) continue;
            const xferWalk = turf.distance(turf.point(s1.coord), turf.point(s2.coord), { units: 'kilometers' });
            if (xferWalk <= 0.20) {
              const seg1 = turf.lineSliceAlong(b.entry.trip, b.stop.locationKm, s1.locationKm, { units: 'kilometers' });
              seg1.properties = { leg: 1 };
              const seg2 = turf.lineSliceAlong(a.entry.trip, s2.locationKm, a.stop.locationKm, { units: 'kilometers' });
              seg2.properties = { leg: 2 };

              const stops1Range = b.entry.stops.filter(
                s => s.locationKm >= b.stop.locationKm && s.locationKm <= s1.locationKm
              );
              const stops2Range = a.entry.stops.filter(
                s => s.locationKm >= s2.locationKm && s.locationKm <= a.stop.locationKm
              );
              const stops1 = stops1Range.map(s => s.name);
              const stops2 = stops2Range.map(s => s.name);

              const stopFeatures = [
                ...stops1Range.map((s, idx) => ({
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: s.coord },
                  properties: {
                    name: s.name,
                    role: idx === 0 ? 'board' : (idx === stops1Range.length - 1 ? 'transfer' : 'intermediate')
                  }
                })),
                ...stops2Range.map((s, idx) => ({
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: s.coord },
                  properties: {
                    name: s.name,
                    role: idx === 0 ? 'transfer' : (idx === stops2Range.length - 1 ? 'alight' : 'intermediate')
                  }
                }))
              ];


              const walkFeatures = [];
              if (b.stop.walkKm > 0.01) walkFeatures.push(turf.lineString([orig, b.stop.coord]));
              if (xferWalk > 0.01) walkFeatures.push(turf.lineString([s1.coord, s2.coord]));
              if (a.stop.walkKm > 0.01) walkFeatures.push(turf.lineString([a.stop.coord, dest]));

              itineraries.push({
                transfers: 1,
                walkKm: b.stop.walkKm + a.stop.walkKm + xferWalk,
                boardWalkKm: b.stop.walkKm,
                xferWalkKm: xferWalk,
                alightWalkKm: a.stop.walkKm,
                fare: (b.entry.trip.properties.fare || 0) + (a.entry.trip.properties.fare || 0),
                legs: [
                  {
                    route: b.entry.trip.properties.route_long,
                    bus: b.entry.trip.properties.vehicle_name,
                    capacity: b.entry.trip.properties.passenger_capacity,
                    board: b.stop.name,
                    alight: s1.name,
                    stops: stops1
                  },
                  {
                    route: a.entry.trip.properties.route_long,
                    bus: a.entry.trip.properties.vehicle_name,
                    capacity: a.entry.trip.properties.passenger_capacity,
                    board: s2.name,
                    alight: a.stop.name,
                    stops: stops2
                  }
                ],
                features: [seg1, seg2],
                walkFeatures: walkFeatures,
                stopFeatures: stopFeatures
              });
              break;
            }
          }
        }
      }
    }
  }

  // Sort by fewest transfers first, then shortest walking distance, and deduplicate
  itineraries.sort((x, y) => (x.transfers - y.transfers) || (x.walkKm - y.walkKm));
  const seen = new Set();
  const unique = itineraries.filter(item => {
    const key = item.legs.map(l => l.route + '|' + l.board + '|' + l.alight).join('->');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  renderResults(unique);
}

// 7. Display summarized route cards with expandable stop timeline
function renderResults(itineraries) {
  sidebarEl.classList.remove('collapsed');
  resultsEl.innerHTML = '';
  if (!itineraries.length) {
    statusEl.textContent = 'No routes found within 800m walking distance. Try selecting a closer stop.';
    clearHighlightedRoute();
    return;
  }

  statusEl.textContent = 'Found trips (' + itineraries.length + ')';

  itineraries.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'route-card' + (idx === 0 ? ' active' : '');

    // 1. Summary Top Row: Transfer pill + Fare & Walk
    const badgeClass = item.transfers === 0 ? 'direct' : 'transfer';
    const badgeText = item.transfers === 0 ? 'Direct' : '1 Transfer';

    // 2. Summary Route Pills (Blue for Leg 1, Orange for Leg 2)
    const routePillsHtml = item.legs.map((leg, i) =>
      `<span class="route-pill leg-${i + 1}"><i class="fa-solid fa-bus"></i> ${leg.route}</span>`
    ).join('<span class="pill-arrow">→</span>');

    // 3. Summary Footer: Origin/Destination stops + Details toggle button
    const firstBoard = item.legs[0].board;
    const lastAlight = item.legs[item.legs.length - 1].alight;

    // 4. Expanded Vertical Timeline HTML
    let timelineHtml = '<div class="trip-timeline">';

    if (item.boardWalkKm > 0.01) {
      timelineHtml += `
        <div class="tl-step walk">
          <div class="tl-marker"><span class="tl-dot dot-walk"></span><span class="tl-line line-walk"></span></div>
          <div class="tl-content tl-muted">Walk ~${Math.round(item.boardWalkKm * 1000)}m to <strong>${firstBoard}</strong></div>
        </div>`;
    }

    item.legs.forEach((leg, legIdx) => {
      const legNum = legIdx + 1;
      const isLastLeg = legIdx === item.legs.length - 1;
      const midStops = leg.stops.slice(1, -1);

      // Boarding stop
      timelineHtml += `
        <div class="tl-step">
          <div class="tl-marker">
            <span class="tl-dot ${legIdx === 0 ? 'dot-board' : 'dot-transfer'}"></span>
            <span class="tl-line line-leg-${legNum}"></span>
          </div>
          <div class="tl-content">
            <div class="tl-stop-name">${leg.board}</div>
            <div class="tl-bus-meta">${leg.bus || 'Bus'} · ${leg.capacity || 'N/A'} seats</div>
          </div>
        </div>`;

      // Intermediate stops
      midStops.forEach(stopName => {
        timelineHtml += `
          <div class="tl-step tl-mid">
            <div class="tl-marker">
              <span class="tl-dot dot-mid"></span>
              <span class="tl-line line-leg-${legNum}"></span>
            </div>
            <div class="tl-content tl-mid-name">${stopName}</div>
          </div>`;
      });

      // Alighting stop (either transfer point or final dropoff)
      timelineHtml += `
        <div class="tl-step">
          <div class="tl-marker">
            <span class="tl-dot ${isLastLeg ? 'dot-alight' : 'dot-transfer'}"></span>
            ${(!isLastLeg || item.alightWalkKm > 0.01) ? '<span class="tl-line line-walk"></span>' : ''}
          </div>
          <div class="tl-content">
            <div class="tl-stop-name">${leg.alight}</div>
          </div>
        </div>`;

      // Transfer walk connector between Leg 1 and Leg 2
      if (!isLastLeg) {
        const xferText = item.xferWalkKm > 0.01
          ? `Transfer walk ~${Math.round(item.xferWalkKm * 1000)}m`
          : 'Transfer at same stop';
        timelineHtml += `
          <div class="tl-step walk">
            <div class="tl-marker"><span class="tl-line line-walk"></span></div>
            <div class="tl-content tl-muted">${xferText}</div>
          </div>`;
      }
    });

    if (item.alightWalkKm > 0.01) {
      timelineHtml += `
        <div class="tl-step walk">
          <div class="tl-marker"><span class="tl-dot dot-walk"></span></div>
          <div class="tl-content tl-muted">Walk ~${Math.round(item.alightWalkKm * 1000)}m to Destination</div>
        </div>`;
    }

    timelineHtml += '</div>';

    card.innerHTML = `
      <div class="card-summary-top">
        <span class="trip-type-badge ${badgeClass}">${badgeText}</span>
        <span class="trip-metrics"><strong>ZMW ${item.fare}</strong> · Walk ~${Math.round(item.walkKm * 1000)}m</span>
      </div>
      <div class="card-route-pills">${routePillsHtml}</div>
      <div class="card-summary-footer">
        <span class="card-endpoints" title="${firstBoard} → ${lastAlight}">
          <strong>${firstBoard}</strong> → <strong>${lastAlight}</strong>
        </span>
        <button type="button" class="details-toggle-btn" aria-expanded="false">
          Details <i class="fa-solid fa-chevron-down"></i>
        </button>
      </div>
      ${timelineHtml}
    `;

    // Toggle details drawer without re-zooming map
    const detailsBtn = card.querySelector('.details-toggle-btn');
    detailsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = card.classList.toggle('expanded');
      detailsBtn.setAttribute('aria-expanded', isExpanded);
      detailsBtn.innerHTML = isExpanded
        ? 'Hide <i class="fa-solid fa-chevron-up"></i>'
        : 'Details <i class="fa-solid fa-chevron-down"></i>';

      if (!card.classList.contains('active')) {
        document.querySelectorAll('.route-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        highlightItinerary(item);
      }
    });

    // Click card body to highlight route on map
    card.addEventListener('click', () => {
      document.querySelectorAll('.route-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      highlightItinerary(item);
    });

    resultsEl.appendChild(card);
    if (idx === 0) highlightItinerary(item);
  });
}

function highlightItinerary(item) {
  const routeFc = { type: 'FeatureCollection', features: item.features };
  const walkFc = { type: 'FeatureCollection', features: item.walkFeatures || [] };
  const stopsFc = { type: 'FeatureCollection', features: item.stopFeatures || [] };

  map.getSource('selected-route').setData(routeFc);
  map.getSource('walk-routes').setData(walkFc);
  map.getSource('selected-stops').setData(stopsFc);

  const allFeatures = [...item.features, ...(item.walkFeatures || [])];
  const bbox = turf.bbox({ type: 'FeatureCollection', features: allFeatures });

  const isMobile = window.innerWidth <= 768;
  const isCollapsed = sidebarEl.classList.contains('collapsed');
  const padding = isMobile
    ? { top: 40, right: 40, bottom: isCollapsed ? 80 : Math.round(window.innerHeight * 0.54), left: 40 }
    : 80;

  map.fitBounds(bbox, { padding: padding, maxZoom: 15 });
}

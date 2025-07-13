// === bms-ini-loader.js ===

// Converts BMS internal Northing/Easting to Lat/Lon
function bmsXYtoLatLon(north_ft, east_ft, datum) {
    if (!north_ft || !east_ft || isNaN(north_ft) || isNaN(east_ft)) return null;

    const FT_PER_DEG = 365221.8846;
    const RAD_TO_DEG = 57.2957795;
    const DEG_TO_RAD = 0.01745329;
    const R_EARTH_FT = 20925700;

    let coordLat_rad = (datum.lat * FT_PER_DEG + north_ft) / R_EARTH_FT;
    const cosLat = Math.cos(coordLat_rad);
    let coordLon_rad = ((datum.lon * DEG_TO_RAD * R_EARTH_FT * cosLat) + east_ft) / (R_EARTH_FT * cosLat);

    const lat = coordLat_rad * RAD_TO_DEG;
    
    const BIAS_LON = -0.2; // adjust this value manually
    const lon = coordLon_rad * RAD_TO_DEG;

    if (isNaN(lat) || isNaN(lon)) return null;
    return [lon, lat];
}

function latLonToBMSXY(lat, lon, datum) {
    const FT_PER_DEG = 365221.8846;
    const DEG_TO_RAD = 0.01745329;
    const R_EARTH_FT = 20925700;

    const coordLat_rad = lat * DEG_TO_RAD;
    const coordLon_rad = lon * DEG_TO_RAD;
    const datumLat_rad = datum.lat * DEG_TO_RAD;
    const datumLon_rad = datum.lon * DEG_TO_RAD;

    const north_ft = R_EARTH_FT * (coordLat_rad - datumLat_rad);
    const east_ft = (R_EARTH_FT * Math.cos(coordLat_rad)) * (coordLon_rad - datumLon_rad);

    return {
        north: Math.round(north_ft),
        east: Math.round(east_ft)
    };
}


function parseBMSINI(content, datum) {
    const lines = content.split('\n');
    const coords = [];
    let landed = false;

    for (const line of lines) {
        if (line.startsWith('target_')) {
            const parts = line.split('=')[1].split(',');
            const north = parseFloat(parts[0]);
            const east = parseFloat(parts[1]);
            const action = parseInt(parts[3]);

            // Skip invalid or uninitialized steerpoints
            if (!north || !east || action === -1 || isNaN(north) || isNaN(east)) {
                console.warn("Skipping bad target:", line);
                continue;
            }

            const latlon = bmsXYtoLatLon(north, east, datum);
            if (!latlon) continue;

            coords.push({ latlon, action });

            // Stop collecting for the route line after first landing
            if (action === 7 && !landed) {
                landed = true;
                coords.stopIndex = coords.length; // Mark where to stop the line
            }
        }
    }

    return coords;
}



function drawRouteOnMap(map, targets) {
    if (!Array.isArray(targets) || targets.length < 2) {
        console.warn("🛑 Not enough data to draw.");
        return;
    }

    const routeCoords = [];
    const stopIndex = targets.stopIndex || targets.length;

    // ✅ Start from STPT 0
    for (let i = 0; i < stopIndex; i++) {
        const point = targets[i];
        if (point && point.latlon) {
            routeCoords.push(point.latlon);
        }
    }

    const routeFeature = new ol.Feature({
        geometry: new ol.geom.LineString(routeCoords)
    });

    routeFeature.setStyle(new ol.style.Style({
        stroke: new ol.style.Stroke({
            color: 'white',
            width: 3
        })
    }));

    const vectorSource = new ol.source.Vector({ features: [routeFeature] });

    // Markers for all steerpoints, including after the first landing
    targets.forEach((point, i) => {
        if (!point || !point.latlon) return;

        const marker = new ol.Feature({
            geometry: new ol.geom.Point(point.latlon)
        });

        marker.setStyle(new ol.style.Style({
            image: new ol.style.Circle({
                radius: 5,
                fill: new ol.style.Fill({ color: 'white' }),
                stroke: new ol.style.Stroke({ color: 'black', width: 1 })
            }),
            text: new ol.style.Text({
                text: `${i}`,
                offsetY: -15,
                font: 'bold 16px sans-serif', 
                fill: new ol.style.Fill({ color: '#fff' }),
                stroke: new ol.style.Stroke({ color: '#000', width: 2 })
            })
        }));

        vectorSource.addFeature(marker);
    });

    const vectorLayer = new ol.layer.Vector({ source: vectorSource });
    map.addLayer(vectorLayer);
}




function addINILoaderUI(map, datum) {
    const input = document.getElementById('ini-loader');
    if (!input) {
        console.warn("INI input element not found in DOM.");
        return;
    }

    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const coords = parseBMSINI(event.target.result, datum);
            drawRouteOnMap(map, coords);
        };
        reader.readAsText(file);
    });
}


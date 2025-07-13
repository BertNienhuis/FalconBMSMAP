let flightPathLayer = null;

const SCALE = 0.00976;

function parseBMSINI(content) {
    const lines = content.split('\n');
    const coords = [];
    const threats = [];
    const lineSegments = [];
    const linePoints = [];

    let landed = false;
    

    for (const line of lines) {
        const trimmed = line.trim();

        // --- STEERPOINTS ---
        if (trimmed.startsWith('target_')) {
            const parts = trimmed.split('=')[1].split(',');
            const north = parseFloat(parts[0]);
            const east = parseFloat(parts[1]);
            const action = parseInt(parts[3]);

            if (!north || !east || isNaN(north) || isNaN(east) || action === -1) continue;

            const x = east * SCALE;
            const y = north * SCALE;

            coords.push({ latlon: [x, y], action });

            if (action === 7 && !landed) {
                landed = true;
                coords.stopIndex = coords.length;
            }
        }

        // --- THREAT CIRCLES ---
        else if (trimmed.startsWith('ppt_')) {
            const parts = trimmed.split('=')[1].split(',');
            if (parts.length < 5) continue;

            const north = parseFloat(parts[0]);
            const east = parseFloat(parts[1]);
            const alt = parseFloat(parts[2]);
            const radius = parseFloat(parts[3]);
            const label = parts[4].trim();

            if ([north, east, alt, radius].every(v => v === 0) || isNaN(north) || isNaN(east) || isNaN(radius)) continue;

            const x = east * SCALE;
            const y = north * SCALE;

            threats.push({
                center: [x, y],
                radius: radius * SCALE,
                label
            });
        }

        // --- CUSTOM LINE PATHS ---
		else if (trimmed.startsWith('lineSTPT_')) {
			const parts = trimmed.split('=')[1].split(',');
			const north = parseFloat(parts[0]);
			const east = parseFloat(parts[1]);

			const isZero = north === 0 && east === 0;

			if (isZero || isNaN(north) || isNaN(east)) {
				// End current segment if it has enough points
				if (linePoints.length >= 2) {
					lineSegments.push([...linePoints]);
				}
				linePoints.length = 0; // Reset current group
				continue;
			}

			const x = east * SCALE;
			const y = north * SCALE;
			linePoints.push([x, y]);

			if (linePoints.length === 6) {
				lineSegments.push([...linePoints]);
				linePoints.length = 0;
			}
		}

    }

    // Push remaining points if any
    if (linePoints.length >= 2) {
        lineSegments.push([...linePoints]);
    }

    return { coords, threats, lineSegments };
}



function drawRouteOnMap(map, data) {
    const { coords, threats, lineSegments } = data;
    const vectorSource = new ol.source.Vector();

    const feetPerPixel = 1 / 0.00976;
    const feetPerNM = 6076.12;
    const stopIndex = coords.stopIndex || coords.length;

    // === ROUTE LINE ===
    if (stopIndex > 1) {
        const routeCoords = coords.slice(0, stopIndex).map(p => p.latlon);

        const routeFeature = new ol.Feature({
            geometry: new ol.geom.LineString(routeCoords)
        });

        routeFeature.setStyle(new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: 'white',
                width: 3
            })
        }));

        vectorSource.addFeature(routeFeature);
    }

    // === MARKERS + DISTANCES ===
    for (let i = 0; i < coords.length; i++) {
        const point = coords[i];
        if (!point?.latlon) continue;

        const marker = new ol.Feature({
            geometry: new ol.geom.Point(point.latlon)
        });

    const isActionType14 = point.action === 14;

    const shapeStyle = isActionType14
    ? new ol.style.RegularShape({
        points: 3,
        radius: 8,
        rotation: 0,
        fill: new ol.style.Fill({ color: 'rgba(255, 255, 255, 0)' }), // transparent
        stroke: new ol.style.Stroke({ color: 'white', width: 2 })
    })
    : new ol.style.Circle({
        radius: 5,
        fill: new ol.style.Fill({ color: '#ffffff00' }),
        stroke: new ol.style.Stroke({ color: 'white', width: 2 })
    });

    marker.setStyle(new ol.style.Style({
        image: shapeStyle,
        text: new ol.style.Text({
            text: `${i }`,
            offsetY: -15,
            font: 'bold 16px sans-serif',
            fill: new ol.style.Fill({ color: '#fff' }),
            stroke: new ol.style.Stroke({ color: '#000', width: 2 })
        })
    }));

       

        vectorSource.addFeature(marker);

        if (i < stopIndex - 1) {
            const next = coords[i + 1]?.latlon;
            if (!next) continue;

            const current = point.latlon;
            const dx = next[0] - current[0];
            const dy = next[1] - current[1];
            const distNM = Math.sqrt(dx * dx + dy * dy) * feetPerPixel / feetPerNM;

            const labelFeature = new ol.Feature({
                geometry: new ol.geom.Point([(current[0] + next[0]) / 2, (current[1] + next[1]) / 2]),
                labelText: `${distNM.toFixed(1)} NM`
            });

            labelFeature.setStyle((feature, resolution) => {
                return new ol.style.Style({
                    text: new ol.style.Text({
                        text: resolution > 6 ? '' : feature.get('labelText'),
                        font: 'bold 12px sans-serif',
                        fill: new ol.style.Fill({ color: 'yellow' }),
                        stroke: new ol.style.Stroke({ color: 'black', width: 3 }),
                        offsetY: -10
                    })
                });
            });

            vectorSource.addFeature(labelFeature);
        }
    }

    // === THREAT CIRCLES ===
    for (const threat of threats) {
        const circleFeature = new ol.Feature({
            geometry: new ol.geom.Circle(threat.center, threat.radius)
        });

        circleFeature.setStyle(new ol.style.Style({
            stroke: new ol.style.Stroke({ color: 'red', width: 2 }),
            fill: new ol.style.Fill({ color: 'rgba(255,0,0,0.1)' })
        }));

        vectorSource.addFeature(circleFeature);

        const labelFeature = new ol.Feature({
            geometry: new ol.geom.Point([
                threat.center[0] - 30,
                threat.center[1] - 30
            ]),
            labelText: threat.label
        });

        labelFeature.setStyle((feature, resolution) => {
            return new ol.style.Style({
                text: new ol.style.Text({
                    text: resolution > 6 ? '' : feature.get('labelText'),
                    font: 'bold 14px sans-serif',
                    fill: new ol.style.Fill({ color: 'red' }),
                    stroke: new ol.style.Stroke({ color: 'white', width: 3 })
                })
            });
        });

        vectorSource.addFeature(labelFeature);
    }

    // === CUSTOM LINES ===
    for (const segment of lineSegments) {
        if (segment.length < 2) continue;

        const lineFeature = new ol.Feature({
            geometry: new ol.geom.LineString(segment)
        });

        lineFeature.setStyle(new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: 'black', // blue line
                width: 2,
                lineDash: [4, 4]
            })
        }));

        vectorSource.addFeature(lineFeature);
    }

    // Remove previous layer if it exists
    if (flightPathLayer) {
        map.removeLayer(flightPathLayer);
    }

    // Create and add new vector layer
    flightPathLayer = new ol.layer.Vector({ source: vectorSource });
    map.addLayer(flightPathLayer);


    
}



function addINILoaderUI(map) {
    const input = document.getElementById('ini-loader');
    if (!input) return;

    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const result = parseBMSINI(event.target.result);
            drawRouteOnMap(map, result);
            
            // Reset input so selecting same file again will trigger change event
            input.value = '';
        };
        reader.readAsText(file);
    });
}

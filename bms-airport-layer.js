const airportLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    visible: true,
    declutter: true
});

let airportOverlay;

function loadAirportIcons(url, map) {
    fetch(url)
        .then(res => res.json())
        .then(json => {
            const airports = json; // your new JSON is a plain array, not inside "Airports"
            const vectorSource = airportLayer.getSource();
            vectorSource.clear();
            const FEET_PER_KM = 3279.98; // Falcon Feet (not real life km > feet)          
            const SCALE = window.getCurrentScale?.() || 1;


            airports.forEach(airport => {
                const kmX = parseFloat(airport.X); // east-west
                const kmY = parseFloat(airport.Y); // north-south

                if (isNaN(kmX) || isNaN(kmY)) return;

                // Convert to Falcon feet then to pixels
                const x = (kmX * FEET_PER_KM) * SCALE;
                const y = (kmY * FEET_PER_KM) * SCALE;

                const coord = [x, y];

                const feature = new ol.Feature({
                    geometry: new ol.geom.Point(coord),
                    name: airport.Objective || 'Unknown',
                    icao: airport.ICAN || airport.ID || '',
                    type: airport.ObjectiveType || '',
                    channel: airport.Channel || '',
                    band: airport.Band || '',
                    freqs: {
                        uhf: airport.UHF || 'N/A',
                        vhf: airport.VHF || 'N/A',
                        ground: airport.GND || 'N/A',
                        approach: airport.APP || 'N/A',
                        ops: airport.OPS || 'N/A',
                        atis: airport.ATIS || 'N/A'
                    },
                    ils: [airport['ILS 1'], airport['ILS 2'], airport['ILS 3'], airport['ILS 4']].filter(x => x)
                });


                feature.setStyle([
                    // Style for the point (circle) — not affected by declutter
                    new ol.style.Style({
                        image: new ol.style.Circle({
                            radius: 5,
                            fill: new ol.style.Fill({ color: 'blue' }),
                            stroke: new ol.style.Stroke({ color: 'white', width: 2 })
                        })
                    }),
                    // Style for the label (text) — decluttered automatically
                    new ol.style.Style({
                        text: new ol.style.Text({
                            text: airport.Objective || '',
                            font: '12px sans-serif',
                            fill: new ol.style.Fill({ color: 'black' }),
                            stroke: new ol.style.Stroke({ color: 'white', width: 2 }),
                            offsetY: -15
                        })
                    })
                ]);

                vectorSource.addFeature(feature);
            });

            if (!map.getLayers().getArray().includes(airportLayer)) {
                map.addLayer(airportLayer);
                createAirportTooltip(map, airportLayer);
                initAirportSearch(map, airportLayer);
            }
        })
        .catch(err => console.error("Failed to load airports:", err));
}

function initAirportSearch(map, airportLayer) {
    const input = document.getElementById('airport-search');
    const results = document.getElementById('airport-search-results');

    input.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();
        results.innerHTML = '';

        if (!query) {
            results.classList.add('hidden');
            return;
        }

        const features = airportLayer.getSource().getFeatures();
        const matches = features.filter(f => {
            const name = f.get('name')?.toLowerCase();
            const icao = f.get('icao')?.toLowerCase();
            return name?.includes(query) || icao?.includes(query);
        });

        matches.slice(0, 10).forEach(feature => {
            const li = document.createElement('li');
            const name = feature.get('name');
            const icao = feature.get('icao');
            li.textContent = `${name}${icao ? ` (${icao})` : ''}`;
            li.addEventListener('click', () => {
                const coord = feature.getGeometry().getCoordinates();
                map.getView().animate({ center: coord, duration: 500, zoom: 5 });
                input.value = '';
                results.classList.add('hidden');
            });
            results.appendChild(li);
        });

        results.classList.toggle('hidden', matches.length === 0);
    });

    // Optional: hide list if clicked elsewhere
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !results.contains(e.target)) {
            results.classList.add('hidden');
        }
    });
}



function createAirportTooltip(map, airportLayer) {
    const container = document.createElement('div');
    container.className = 'airport-tooltip';
    document.body.appendChild(container);

    airportOverlay = new ol.Overlay({
        element: container,
        offset: [10, 0],
        positioning: 'bottom-left',
        stopEvent: false
    });

    map.addOverlay(airportOverlay);

    map.on('click', evt => {
        let found = false;
        map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
            if (layer === airportLayer) {
                const name = feature.get('name');
                const icao = feature.get('icao');
                const type = feature.get('type');
                const channel = feature.get('channel');
                const band = feature.get('band');
                const freqs = feature.get('freqs') || {};
                const ils = feature.get('ils') || [];

                container.innerHTML = `
                    <strong>${name}${icao ? ` (${icao})` : ''}</strong><br>
                    <em>${type}</em><br><br>
                    <strong>Tacan:</strong>${channel} ${band}<br><br>
                    <strong>Frequencies:</strong>
                    <div class="freq-grid">
                    <div>Ground:</div><div>${freqs.ground}</div>
                    <div>Tower UHF:</div><div>${freqs.uhf}</div>
                    <div>Tower VHF:</div><div>${freqs.vhf}</div>
                    <div>Approach:</div><div>${freqs.approach}</div>
                    <div>Ops:</div><div>${freqs.ops}</div>
                    <div>ATIS:</div><div>${freqs.atis}</div>
                    </div>

                    ${ils.length ? `<br><strong>ILS:</strong><br>- ${ils.join('<br> - ')}` : ''}
                `;
                const pixel = map.getPixelFromCoordinate(evt.coordinate);
                const mapSize = map.getSize(); // [width, height]
                
                let positioning = 'top-left';
                let offset = [10, 0];
                
                // 🔁 Flip vertically if near bottom
                if (pixel[1] > mapSize[1] - 300) {
                    positioning = 'bottom-left';
                }
                
                // 🔁 Flip horizontally if near right edge
                if (pixel[0] > mapSize[0] - 350) {
                    positioning = positioning.includes('top') ? 'top-right' : 'bottom-right';
                    offset = [-10, 0];
                }
                
                airportOverlay.setPositioning(positioning);
                airportOverlay.setOffset(offset);
                airportOverlay.setPosition(evt.coordinate);
                

                
                found = true;
            }
        });

        if (!found) {
            airportOverlay.setPosition(undefined);
        }
    });
}

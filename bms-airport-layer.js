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
                const x = (kmX * FEET_PER_KM) * SCALE ;
                const y = (kmY * FEET_PER_KM) * SCALE;

                const coord = [x, y];

                const feature = new ol.Feature({
                    geometry: new ol.geom.Point(coord),
                    name: airport.Objective || 'Unknown',
                    icao: airport.ICAN || airport.ID || '',
                    type: airport.ObjectiveType || '',
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
            }
        })
        .catch(err => console.error("Failed to load airports:", err));
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
                const freqs = feature.get('freqs') || {};
                const ils = feature.get('ils') || [];

                container.innerHTML = `
                    <strong>${name}${icao ? ` (${icao})` : ''}</strong><br>
                    <em>${type}</em><br><br>
                    <strong>Frequencies:</strong><br>
                    Ground: ${freqs.ground}<br>
                    Tower UHF: ${freqs.uhf} <br>
                    Tower VHF: ${freqs.vhf} <br>
                    Approach: ${freqs.approach}<br>
                    Ops: ${freqs.ops}<br>
                    ATIS: ${freqs.atis}<br>
                    ${ils.length ? `<br><strong>ILS:</strong><br>- ${ils.join('<br> - ')}` : ''}
                `;
                airportOverlay.setPosition(evt.coordinate);
                found = true;
            }
        });

        if (!found) {
            airportOverlay.setPosition(undefined);
        }
    });
}

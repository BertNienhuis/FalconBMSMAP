const airportLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    visible: true,
    declutter: true
});

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
                    icao: airport.ID || ''
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
            }
        })
        .catch(err => console.error("Failed to load airports:", err));
}

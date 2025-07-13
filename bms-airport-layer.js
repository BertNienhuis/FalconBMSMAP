const airportLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    visible: true
});

function loadAirportIcons(url, map) {
    fetch(url)
        .then(res => res.json())
        .then(json => {
            const airports = json.Airports?.Airport || [];
            const vectorSource = airportLayer.getSource();
            vectorSource.clear();

            const SCALE = 0.00976; // Use the same as bms-ini-loader

            airports.forEach(airport => {
                const rawX = parseFloat(airport.x); // in feet
                const rawY = parseFloat(airport.y); // in feet
                if (isNaN(rawX) || isNaN(rawY)) return;

                const x = rawX * SCALE;
                const y = rawY * SCALE; // DO NOT flip Y — your map origin is bottom-left due to tileGrid.origin

                const coord = [x, y];

                const feature = new ol.Feature({
                    geometry: new ol.geom.Point(coord),
                    name: airport.name || 'Unknown',
                    icao: airport.icao || ''
                });

                feature.setStyle(new ol.style.Style({
                    image: new ol.style.Circle({
                        radius: 5,
                        fill: new ol.style.Fill({ color: 'blue' }),
                        stroke: new ol.style.Stroke({ color: 'white', width: 2 })
                    }),
                    text: new ol.style.Text({
                        text: airport.icao || airport.Name || '',
                        font: '12px sans-serif',
                        fill: new ol.style.Fill({ color: 'black' }),
                        stroke: new ol.style.Stroke({ color: 'white', width: 2 }),
                        offsetY: -15
                    })
                }));

                vectorSource.addFeature(feature);
            });

            if (!map.getLayers().getArray().includes(airportLayer)) {
                map.addLayer(airportLayer);
            }
        })
        .catch(err => console.error("Failed to load airports:", err));
}

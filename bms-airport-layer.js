const airportLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    visible: true
});

// Falcon map coordinate system
const FALCON_SCALE = 0.00600; // feet to pixel scale (based on 32768 map)
const MAP_HEIGHT = 32768;     // Needed for Y flip

function loadAirportIcons(url, map) {
    fetch(url)
        .then(res => res.json())
        .then(json => {
            const airports = json.Airports?.Airport || [];
            const vectorSource = airportLayer.getSource();
            vectorSource.clear();

            airports.forEach(airport => {
                const rawX = parseFloat(airport.x);
                const rawY = parseFloat(airport.y);
                if (!rawX || !rawY) return;

                const x = rawX * FALCON_SCALE;
                const y = rawY * FALCON_SCALE; 

                const coord = [x, y];

                const feature = new ol.Feature({
                    geometry: new ol.geom.Point(coord),
                    name: airport.Name || 'Unknown',
                    icao: airport.ICAO || ''
                });

                feature.setStyle(new ol.style.Style({
                    image: new ol.style.Circle({
                        radius: 5,
                        fill: new ol.style.Fill({ color: 'blue' }),
                        stroke: new ol.style.Stroke({ color: 'white', width: 2 })
                    }),
                    text: new ol.style.Text({
                        text: airport.Name || '',
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

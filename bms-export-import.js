(function () {
    const format = new ol.format.GeoJSON();

    function exportLayers() {
        const format = new ol.format.GeoJSON();
        const allFeatures = [];

        if (window.whiteboardSource) {
            const whiteboardFeatures = window.whiteboardSource.getFeatures().map(f => {
              const geom = f.getGeometry();
          
              if (geom instanceof ol.geom.Circle) {
                const center = geom.getCenter();
                const radius = geom.getRadius();
          
                const circleAsPoint = new ol.Feature({
                  geometry: new ol.geom.Point(center)
                });
          
                circleAsPoint.setProperties({
                  __layer: 'whiteboard',
                  originalShape: 'circle',
                  radius
                });
          
                return circleAsPoint;
              } else {
                // Preserve other shapes
                f.setProperties({
                  ...f.getProperties(),
                  __layer: 'whiteboard'
                });
                return f;
              }
            });
          
            allFeatures.push(...whiteboardFeatures);
          }        
        

        if (window.markerSource) {
            const markerFeatures = window.markerSource.getFeatures().map(f => {
                f.setProperties({
                    ...f.getProperties(),
                    __layer: 'marker',
                    iconUrl: f.getStyle()?.getImage()?.getSrc() || ''
                });
                return f;
            });
            allFeatures.push(...markerFeatures);
        }

        // --- Extract bullseye center point only
        if (window.currentBullseye) {
            const centerPoint = new ol.Feature(new ol.geom.Point(window.currentBullseye));
            centerPoint.set('__layer', 'bullseye-center');
            allFeatures.push(centerPoint);
        }


        const geojson = format.writeFeaturesObject(allFeatures);
        const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'bms-layers.json';
        a.click();

        return geojson;
    }




    function importLayers(json) {
        const format = new ol.format.GeoJSON();

        let geojsonObj;
        try {
            geojsonObj = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (err) {
            console.error('Invalid JSON:', err);
            return;
        }

        if (!geojsonObj || geojsonObj.type !== 'FeatureCollection' || !Array.isArray(geojsonObj.features)) {
            console.warn('Invalid GeoJSON structure');
            return;
        }

        // ✅ Filter only valid features
        const validFeatures = geojsonObj.features.filter(f => {
            const geom = f.geometry;
            if (!geom || !geom.type) return false;
            if (geom.type === 'GeometryCollection' && (!geom.geometries || geom.geometries.length === 0)) return false;
            return true;
        });

        let features;
        try {
            features = format.readFeatures({
                type: 'FeatureCollection',
                features: validFeatures
            });
        } catch (err) {
            console.error('GeoJSON parse error:', err);
            return;
        }

        if (!features.length) {
            console.warn('No features to import');
            return;
        }

        features.forEach(f => {
            const layerTag = f.get('__layer');
            if (!layerTag) return;

            switch (layerTag) {
                case 'whiteboard':
                    const shape = f.get('originalShape');

                    if (shape === 'circle' && f.getGeometry() instanceof ol.geom.Point) {
                        const center = f.getGeometry().getCoordinates();
                        const radius = f.get('radius');

                        if (!isNaN(radius)) {
                        const circle = new ol.geom.Circle(center, radius);
                        const circleFeature = new ol.Feature(circle);

                        circleFeature.setProperties(f.getProperties());
                        circleFeature.setGeometry(circle);
                        window.whiteboardSource?.addFeature(circleFeature);
                        break;
                        }
                    }

                    // Default fallback for non-circle whiteboard shapes
                    window.whiteboardSource?.addFeature(f);
                    break;

                case 'marker':
                    // Ensure the marker source/layer exist
                    if (!window.markerSource || !window.markerLayer) {
                        window.markerSource = new ol.source.Vector();
                        window.markerLayer = new ol.layer.Vector({ source: window.markerSource });
                        map.addLayer(window.markerLayer);
                    }

                    // ✅ Explicitly restore the iconUrl from properties
                    const iconUrl = f.get('iconUrl');
                    if (iconUrl) {
                        f.set('iconUrl', iconUrl);
                    }

                    f.setStyle(getMarkerStyle(f));
                    window.markerSource.addFeature(f);
                    break;


                case 'bullseye-center':
                    if (window.setBullseyeCenter && f.getGeometry()) {
                        const coords = f.getGeometry().getCoordinates();
                        window.setBullseyeCenter(coords);
                    }
                    break;

                default:
                    console.warn('Unknown __layer:', layerTag);
            }
        });
    }


    document.addEventListener('DOMContentLoaded', () => {
        const importInput = document.getElementById('import-layers');
        const exportButton = document.getElementById('export-layers');

        if (!importInput || !exportButton) {
            console.error('Import or export elements not found!');
            return;
        }

        importInput.addEventListener('change', event => {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const json = JSON.parse(reader.result);
                    importLayers(json);
                } catch (e) {
                    console.error('Invalid JSON:', e);
                }
            };
            reader.readAsText(file);
        });

        exportButton.addEventListener('click', exportLayers);


    });





})();

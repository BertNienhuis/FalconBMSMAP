let isRulerActive = false;
let rulerLayer = null;
let startCoord = null;
let lineFeature = null;
let labelFeature = null;
let moveListener = null;
let upListener = null;
let rulerDragPan = null;

function enableRuler(map, button) {
    if (isRulerActive) return;
    isRulerActive = true;
    map.getTargetElement().style.cursor = 'crosshair';
    button?.classList.add('active');

    // Disable map drag
    rulerDragPan = map.getInteractions().getArray().find(i => i instanceof ol.interaction.DragPan);
    if (rulerDragPan) {
        map.removeInteraction(rulerDragPan);
    }

    const source = new ol.source.Vector();
    rulerLayer = new ol.layer.Vector({
        source,
        declutter: true
    });
    map.addLayer(rulerLayer);

    map.once('pointerdown', e => {
        startCoord = e.coordinate;

        lineFeature = new ol.Feature({
            geometry: new ol.geom.LineString([startCoord, startCoord])
        });
        lineFeature.setStyle(new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: 'black',
                width: 2
            })
        }));

        labelFeature = new ol.Feature(new ol.geom.Point(startCoord));
        source.addFeatures([lineFeature, labelFeature]);

        moveListener = map.on('pointermove', moveEvent => {
            const endCoord = moveEvent.coordinate;
            lineFeature.getGeometry().setCoordinates([startCoord, endCoord]);

            const dx = endCoord[0] - startCoord[0];
            const dy = endCoord[1] - startCoord[1];
            const dist = Math.sqrt(dx * dx + dy * dy);

            const scale = window.getCurrentScale?.() || 0.00976;
            const feetPerPixel = 1 / scale;
            const feetPerNM = 6076.12;
            const distNM = (dist * feetPerPixel) / feetPerNM;

            const angleRad = Math.atan2(dx, dy);
            const angleDeg = (angleRad * 180 / Math.PI + 360) % 360;

            const mid = [(startCoord[0] + endCoord[0]) / 2, (startCoord[1] + endCoord[1]) / 2];
            labelFeature.setGeometry(new ol.geom.Point(mid));
            labelFeature.setStyle(new ol.style.Style({
                text: new ol.style.Text({
                    text: `${distNM.toFixed(1)} NM / ${angleDeg.toFixed(0)}°`,
                    font: 'bold 14px sans-serif',
                    fill: new ol.style.Fill({ color: 'white' }),
                    stroke: new ol.style.Stroke({ color: 'black', width: 3 }),
                    offsetY: -12
                })
            }));
        });

        upListener = map.once('pointerup', () => {
            disableRuler(map, button);
        });
    });
}

function disableRuler(map, button) {
    if (moveListener) {
        ol.Observable.unByKey(moveListener);
        moveListener = null;
    }
    if (upListener) {
        ol.Observable.unByKey(upListener);
        upListener = null;
    }
    if (rulerLayer) {
        map.removeLayer(rulerLayer);
        rulerLayer = null;
    }
    if (rulerDragPan) {
        map.addInteraction(rulerDragPan);
        rulerDragPan = null;
    }

    isRulerActive = false;
    startCoord = null;
    lineFeature = null;
    labelFeature = null;
    button?.classList.remove('active');
    map.getTargetElement().style.cursor = '';

}

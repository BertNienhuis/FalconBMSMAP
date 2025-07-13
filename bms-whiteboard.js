let whiteboardSource = null;
let whiteboardLayer = null;
let whiteboardDrawInteraction = null;
let whiteboardEnabled = false;
let currentDrawType = 'Freehand';
const currentColor = 'red';
let dragPanInteraction = null;

const undoStack = [];
const redoStack = [];

function initWhiteboard(map) {
    // Save dragPan interaction
    dragPanInteraction = map.getInteractions().getArray().find(i => i instanceof ol.interaction.DragPan);

    whiteboardSource = new ol.source.Vector();
    whiteboardLayer = new ol.layer.Vector({
        source: whiteboardSource,
        style: feature => {
            return new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: currentColor,
                    width: 2
                }),
                fill: new ol.style.Fill({
                    color: 'rgba(0, 0, 0, 0)' // transparent fill
                })
            });
        }
    });
    map.addLayer(whiteboardLayer);

    // Button events
    const tools = {
        'whiteboard-pencil': 'Freehand',
        'whiteboard-rect': 'Rectangle',
        'whiteboard-polygon': 'Polygon',
        'whiteboard-circle': 'Circle'
    };

    for (const [id, type] of Object.entries(tools)) {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', () => {
                toggleDraw(map, type);
                setActiveButton(btn);
            });
        }
    }

    document.getElementById('whiteboard-eraser')?.addEventListener('click', () => {
        whiteboardSource.clear();
    });
}

function toggleDraw(map, type) {
    if (currentDrawType === type && whiteboardEnabled) {
        disableWhiteboardDrawing(map);
        whiteboardEnabled = false;
    } else {
        currentDrawType = type;
        if (whiteboardEnabled) disableWhiteboardDrawing(map);
        enableWhiteboardDrawing(map);
        whiteboardEnabled = true;
    }
}

function enableWhiteboardDrawing(map) {
    let geometryFunction = null;
    let drawType = 'LineString';
    let freehand = false;

    switch (currentDrawType) {
        case 'Freehand':
            drawType = 'LineString';
            freehand = true;
            break;
        case 'Rectangle':
            drawType = 'Circle';
            geometryFunction = ol.interaction.Draw.createBox();
            freehand = false;
            break;
        case 'Circle':
            drawType = 'Circle';
            freehand = false; // set to true on touch devices below
            break;
        case 'Polygon':
            drawType = 'Polygon';
            break;
    }

    // ✅ Fix: enable freehand for Circle on touch devices (iPad compatibility trick)
    if ((currentDrawType === 'Circle' || currentDrawType === 'Rectangle') && 'ontouchstart' in window) {
        freehand = true;
    }

    // Disable map panning while drawing
    dragPanInteraction?.setActive(false);

    whiteboardDrawInteraction = new ol.interaction.Draw({
        source: whiteboardSource,
        type: drawType,
        geometryFunction,
        freehand,
        style: getDrawingStyle()
    });

    whiteboardDrawInteraction.on('drawend', (event) => {
        const feature = event.feature;
        undoStack.push(feature);
        redoStack.length = 0;

        disableWhiteboardDrawing(map);
        whiteboardEnabled = false;

        document.querySelectorAll('#control-bar .button').forEach(btn => {
            btn.classList.remove('active');
        });
    });

    map.addInteraction(whiteboardDrawInteraction);
}

function getDrawingStyle() {
    return function (feature) {
        const geometry = feature.getGeometry();
        const type = geometry.getType();

        const shapeStyle = new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: currentColor,
                width: 2,
                lineDash: [4, 4]
            }),
            fill: new ol.style.Fill({
                color: 'rgba(255, 0, 0, 0.1)'
            })
        });

        const pointStyle = new ol.style.Style({
            image: new ol.style.Circle({
                radius: 5,
                fill: new ol.style.Fill({ color: 'rgba(0, 153, 255, 0.9)' }),
                stroke: new ol.style.Stroke({ color: 'white', width: 1 })
            }),
            geometry: function () {
                if (type === 'Point') return geometry;
                if (type === 'LineString') {
                    const coords = geometry.getCoordinates();
                    return new ol.geom.Point(coords[coords.length - 1]);
                }
                if (type === 'Polygon') {
                    const coords = geometry.getCoordinates()[0];
                    return new ol.geom.Point(coords[coords.length - 1]);
                }
                return null;
            }
        });

        return [shapeStyle, pointStyle];
    };
}



function disableWhiteboardDrawing(map) {
    if (whiteboardDrawInteraction) {
        map.removeInteraction(whiteboardDrawInteraction);
        whiteboardDrawInteraction = null;
    }

    // Re-enable panning
    dragPanInteraction?.setActive(true);
}

function setActiveButton(activeBtn) {
    document.querySelectorAll('#control-bar .button').forEach(btn => {
        btn.classList.remove('active');
    });
    activeBtn.classList.add('active');
}

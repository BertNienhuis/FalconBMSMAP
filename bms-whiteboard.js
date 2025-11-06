let whiteboardSource = null;
let whiteboardLayer = null;
let whiteboardDrawInteraction = null;
let whiteboardEnabled = false;
let currentDrawType = 'Freehand';
let whiteboardDragPan = null;

const undoStack = [];
const redoStack = [];

const defaultWhiteboardStyle = Object.freeze({
    strokeColor: '#ff0000',
    fillColor: '#ff0000',
    fillOpacity: 0.2,
    lineWidth: 2,
    lineType: 'full'
});

const VALID_LINE_TYPES = ['full', 'striped', 'dotted'];

let whiteboardStyleOptions = { ...defaultWhiteboardStyle };

function initWhiteboard(map) {
    if (whiteboardDrawInteraction) {
        map.removeInteraction(whiteboardDrawInteraction);
        whiteboardDrawInteraction = null;
    }
    if (whiteboardLayer) {
        map.removeLayer(whiteboardLayer);
        whiteboardLayer = null;
    }

    whiteboardSource = new ol.source.Vector();
    whiteboardLayer = new ol.layer.Vector({
        source: whiteboardSource,
        style: feature => buildDrawingStyles(getFeatureStyleOptions(feature), feature, false)
    });
    map.addLayer(whiteboardLayer);

    whiteboardSource.on('addfeature', (event) => {
        const feature = event.feature;
        const options = getFeatureStyleOptions(feature);
        feature.set('whiteboardStyle', options);
        if (!feature.get('whiteboardShape')) {
            if (feature.get('whiteboardText')) {
                feature.set('whiteboardShape', 'text');
            } else {
                const geomType = feature.getGeometry()?.getType()?.toLowerCase();
                if (geomType) {
                    feature.set('whiteboardShape', geomType);
                }
            }
        }
        feature.setStyle(buildDrawingStyles(options, feature, false));
    });

    whiteboardDragPan = map.getInteractions().getArray().find(i => i instanceof ol.interaction.DragPan);

    const tools = {
        'whiteboard-pencil': 'Freehand',
        'whiteboard-rect': 'Rectangle',
        'whiteboard-polygon': 'Polygon',
        'whiteboard-circle': 'Circle',
        'whiteboard-text': 'Text'
    };

    for (const [id, type] of Object.entries(tools)) {
        const btn = document.getElementById(id);
        if (btn) {
            btn.onclick = () => {
                const isAlreadyActive = btn.classList.contains('active');
                window.deactivateAllTools(map);
                window.showWhiteboardToolbar?.();
                if (isAlreadyActive) {
                    disableWhiteboardDrawing(map);
                    whiteboardEnabled = false;
                    btn.classList.remove('active');
                } else {
                    toggleDraw(map, type);
                    setActiveButton(btn);
                }
            };
        }
    }

    setupWhiteboardStyleControls();

    window.whiteboardLayer = whiteboardLayer;
    window.whiteboardSource = whiteboardSource;

    const eraser = document.getElementById('whiteboard-eraser');
    if (eraser) {
        eraser.onclick = () => {
            whiteboardSource.clear();
            undoStack.length = 0;
            redoStack.length = 0;
        };
    }
}

function setupWhiteboardStyleControls() {
    const strokeColorInput = document.getElementById('whiteboard-stroke-color');
    if (strokeColorInput) {
        strokeColorInput.value = whiteboardStyleOptions.strokeColor;
        strokeColorInput.oninput = (event) => {
            whiteboardStyleOptions = normalizeStyleOptions({
                ...whiteboardStyleOptions,
                strokeColor: event.target.value
            });
            refreshActiveDrawStyle();
        };
    }

    const lineWidthInput = document.getElementById('whiteboard-line-width');
    if (lineWidthInput) {
        lineWidthInput.value = String(whiteboardStyleOptions.lineWidth);
        lineWidthInput.oninput = (event) => {
            const width = Number(event.target.value);
            whiteboardStyleOptions = normalizeStyleOptions({
                ...whiteboardStyleOptions,
                lineWidth: width
            });
            refreshActiveDrawStyle();
        };
    }

    const fillOpacityInput = document.getElementById('whiteboard-fill-opacity');
    if (fillOpacityInput) {
        fillOpacityInput.value = String(Math.round(whiteboardStyleOptions.fillOpacity * 100));
        fillOpacityInput.oninput = (event) => {
            const opacity = Number(event.target.value) / 100;
            whiteboardStyleOptions = normalizeStyleOptions({
                ...whiteboardStyleOptions,
                fillOpacity: opacity
            });
            refreshActiveDrawStyle();
        };
    }

    const lineTypeSelect = document.getElementById('whiteboard-line-type');
    if (lineTypeSelect) {
        lineTypeSelect.value = whiteboardStyleOptions.lineType;
        lineTypeSelect.onchange = (event) => {
            const value = event.target.value;
            whiteboardStyleOptions = normalizeStyleOptions({
                ...whiteboardStyleOptions,
                lineType: VALID_LINE_TYPES.includes(value) ? value : defaultWhiteboardStyle.lineType
            });
            refreshActiveDrawStyle();
        };
    }

    updateStyleIndicators();
    window.whiteboardStyleOptions = { ...whiteboardStyleOptions };
}

function refreshActiveDrawStyle() {
    updateStyleIndicators();
    if (whiteboardDrawInteraction) {
        whiteboardDrawInteraction.setStyle(sketchStyleFunction);
    }
    window.whiteboardStyleOptions = { ...whiteboardStyleOptions };
}

function updateStyleIndicators() {
    whiteboardStyleOptions = normalizeStyleOptions(whiteboardStyleOptions);
    const snapshot = whiteboardStyleOptions;

    const strokeColorInput = document.getElementById('whiteboard-stroke-color');
    if (strokeColorInput) {
        strokeColorInput.value = snapshot.strokeColor;
    }

    const strokeSwatch = document.querySelector('.whiteboard-color-swatch[data-role="stroke"]');
    if (strokeSwatch) {
        const strokePreview = hexToRgba(snapshot.strokeColor, 1);
        strokeSwatch.style.background = strokePreview;
        strokeSwatch.style.borderColor = 'rgba(15, 23, 42, 0.25)';
    }

    const lineWidthInput = document.getElementById('whiteboard-line-width');
    if (lineWidthInput) {
        lineWidthInput.value = String(snapshot.lineWidth);
    }

    const fillOpacityInput = document.getElementById('whiteboard-fill-opacity');
    if (fillOpacityInput) {
        fillOpacityInput.value = String(Math.round(snapshot.fillOpacity * 100));
    }

    const lineTypeSelect = document.getElementById('whiteboard-line-type');
    if (lineTypeSelect) {
        lineTypeSelect.value = snapshot.lineType;
    }
}

function getFeatureStyleOptions(feature) {
    const stored = feature.get('whiteboardStyle');
    if (stored) {
        return normalizeStyleOptions(stored);
    }
    return normalizeStyleOptions(whiteboardStyleOptions);
}

function getCurrentStyleSnapshot() {
    return normalizeStyleOptions(whiteboardStyleOptions);
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
            break;
        case 'Circle':
            drawType = 'Circle';
            break;
        case 'Polygon':
            drawType = 'Polygon';
            break;
        case 'Text':
            drawType = 'Point';
            break;
    }

    if ((currentDrawType === 'Circle' || currentDrawType === 'Rectangle') && 'ontouchstart' in window) {
        freehand = true;
    }

    whiteboardDragPan?.setActive(false);

    whiteboardDrawInteraction = new ol.interaction.Draw({
        source: whiteboardSource,
        type: drawType,
        geometryFunction,
        freehand,
        style: sketchStyleFunction
    });

    whiteboardDrawInteraction.on('drawend', (event) => {
        const feature = event.feature;
        let cancelled = false;
        let styleOptions = getCurrentStyleSnapshot();

        if (currentDrawType === 'Text') {
            const userInput = window.prompt('Enter text label for the map:', '');
            const textValue = userInput ? userInput.trim() : '';
            if (!textValue) {
                whiteboardSource?.removeFeature(feature);
                cancelled = true;
            } else {
                feature.set('whiteboardText', textValue);
            }
        }

        if (!cancelled) {
            feature.set('whiteboardShape', currentDrawType.toLowerCase());
            feature.set('whiteboardStyle', styleOptions);
            feature.setStyle(buildDrawingStyles(styleOptions, feature, false));
            undoStack.push(feature);
            redoStack.length = 0;
        }

        disableWhiteboardDrawing(map);
        whiteboardEnabled = false;

        document.querySelectorAll('#control-bar .button:not(#whiteboard-toolbar-toggle), #whiteboard-toolbar .button').forEach(btn => {
            btn.classList.remove('active');
        });
    });

    map.addInteraction(whiteboardDrawInteraction);
}

function disableWhiteboardDrawing(map) {
    if (whiteboardDrawInteraction) {
        map.removeInteraction(whiteboardDrawInteraction);
        whiteboardDrawInteraction = null;
    }
    whiteboardDragPan?.setActive(true);
}

function sketchStyleFunction(feature) {
    return buildDrawingStyles(whiteboardStyleOptions, feature, true);
}

function buildDrawingStyles(styleOptions, feature, includeHandle) {
    const normalized = normalizeStyleOptions(styleOptions);
    const geometry = feature.getGeometry();
    const isTextFeature = Boolean(feature.get('whiteboardText'));

    const styles = [];
    if (isTextFeature && geometry) {
        const textStyle = createTextStyle(normalized, feature);
        if (textStyle) styles.push(textStyle);
    } else {
        styles.push(createShapeStyle(normalized));
    }

    if (includeHandle && !isTextFeature) {
        const handle = createHandleStyle(feature);
        if (handle) {
            styles.push(handle);
        }
    }
    return styles;
}

function createShapeStyle(options) {
    const stroke = new ol.style.Stroke({
        color: options.strokeColor,
        width: options.lineWidth,
        lineDash: getLineDashPattern(options.lineType),
        lineCap: options.lineType === 'dotted' ? 'round' : 'butt'
    });

    const fillColor = hexToRgba(options.fillColor, options.fillOpacity);

    return new ol.style.Style({
        stroke,
        fill: new ol.style.Fill({
            color: fillColor
        })
    });
}

function createTextStyle(options, feature) {
    const textValue = feature.get('whiteboardText');
    if (!textValue) return null;

    const fontSize = Math.round(16 + options.lineWidth * 2);
    const textColor = hexToRgba(options.strokeColor, 1);
    return new ol.style.Style({
        text: new ol.style.Text({
            text: textValue,
            font: `600 ${fontSize}px 'Segoe UI', sans-serif`,
            fill: new ol.style.Fill({ color: textColor }),
            stroke: new ol.style.Stroke({
                color: 'rgba(15, 23, 42, 0.6)',
                width: Math.max(1.5, options.lineWidth / 1.5)
            }),
            padding: [0, 0, 0, 0],
            textAlign: 'center',
            textBaseline: 'middle',
            overflow: true
        })
    });
}

function createHandleStyle(feature) {
    const geometry = feature.getGeometry();
    if (!geometry) return null;
    const type = geometry.getType();
    if (type === 'Point') return null;

    const handleStyle = new ol.style.Style({
        image: new ol.style.Circle({
            radius: 5,
            fill: new ol.style.Fill({ color: 'rgba(0, 153, 255, 0.9)' }),
            stroke: new ol.style.Stroke({ color: 'white', width: 1 })
        })
    });

    handleStyle.setGeometry(() => {
        const geom = feature.getGeometry();
        if (!geom) return null;
        const geomType = geom.getType();
        if (geomType === 'Point') return geom;
        const coords = geom.getCoordinates();
        if (!coords) return null;
        if (Array.isArray(coords) && geomType === 'LineString') {
            return new ol.geom.Point(coords[coords.length - 1]);
        }
        if (Array.isArray(coords) && geomType === 'Polygon') {
            const ring = coords[0] || [];
            return ring.length ? new ol.geom.Point(ring[ring.length - 1]) : null;
        }
        return null;
    });

    return handleStyle;
}

function getLineDashPattern(type) {
    switch (type) {
        case 'striped':
            return [10, 6];
        case 'dotted':
            return [2, 6];
        default:
            return undefined;
    }
}

function hexToRgba(hex, alpha) {
    if (!isHexColor(hex)) {
        return hex;
    }
    let value = hex.replace('#', '');
    if (value.length === 3) {
        value = value.split('').map(ch => ch + ch).join('');
    }
    const bigint = parseInt(value, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    const resolvedAlpha = clamp(alpha, 0, 1, defaultWhiteboardStyle.fillOpacity);
    return `rgba(${r}, ${g}, ${b}, ${resolvedAlpha})`;
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (Number.isNaN(number)) {
        return fallback;
    }
    return Math.min(Math.max(number, min), max);
}

function isHexColor(value) {
    return typeof value === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(value);
}

function normalizeStyleOptions(options) {
    const base = {
        strokeColor: defaultWhiteboardStyle.strokeColor,
        fillOpacity: defaultWhiteboardStyle.fillOpacity,
        lineWidth: defaultWhiteboardStyle.lineWidth,
        lineType: defaultWhiteboardStyle.lineType
    };

    if (options) {
        if (isHexColor(options.strokeColor)) {
            base.strokeColor = options.strokeColor;
        }
        base.fillOpacity = clamp(options.fillOpacity, 0, 1, defaultWhiteboardStyle.fillOpacity);
        base.lineWidth = clamp(options.lineWidth, 1, 20, defaultWhiteboardStyle.lineWidth);
        base.lineType = VALID_LINE_TYPES.includes(options.lineType) ? options.lineType : defaultWhiteboardStyle.lineType;
    }

    base.fillColor = base.strokeColor;

    return base;
}

function setActiveButton(activeBtn) {
    document.querySelectorAll('#control-bar .button:not(#whiteboard-toolbar-toggle), #whiteboard-toolbar .button').forEach(btn => {
        btn.classList.remove('active');
    });
    activeBtn.classList.add('active');
}

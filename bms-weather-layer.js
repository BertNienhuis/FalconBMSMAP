(function () {
    const WEATHER_CLASSES = {
        1: { label: 'Clear', color: '#facc15' },
        2: { label: 'Fair', color: '#a3e635' },
        3: { label: 'Poor', color: '#60a5fa' },
        4: { label: 'Inclement', color: '#f97316' }
    };

    const CLOUD_TYPES = {
        1: 'Few',
        2: 'Scattered',
        3: 'Broken',
        4: 'Overcast',
        5: 'Storm'
    };

    const WIND_ALTITUDES_FT = [0, 3000, 6000, 9000, 12000, 18000, 24000, 30000, 40000, 50000];
    const SAMPLE_STEP = 2;

    const FMAP_LAYER_OFFSETS = {
        weatherType: 11,          // int32
        pressure: 3492,           // float32
        temperature: 6973,        // float32
        windSpeed: 10454,         // float32
        windDirection: 45264,     // float32
        cloudBase: 80074,         // float32
        cloudCover: 83555,        // uint32
        cloudSize: 87036,         // float32
        cloudType: 90517          // uint32
    };

    const VERSION_DATA_OFFSETS = {
        // Version-indexed offsets (0-based version). 0 indicates not available.
        shower:     [0, 0, 0, 0, 0, 0, 0, 0, 0, 93998],
        visibility: [0, 0, 0, 0, 0, 93998, 93998, 93998, 97479, 97479],
        fog:        [0, 0, 0, 0, 0, 0, 0, 0, 0, 100960]
    };

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function parseFmap(buffer) {
        const view = new DataView(buffer);
        let offset = 0;

        const readInt = () => {
            const value = view.getInt32(offset, true);
            offset += 4;
            return value;
        };

        const readFloat = () => {
            const value = view.getFloat32(offset, true);
            offset += 4;
            return value;
        };

        const version = readInt();
        const columns = readInt();
        const rows = readInt();
        const nodeCount = readInt();
        const cellSpacingKm = readFloat();
        const anchor = Array.from({ length: 6 }, () => readInt());
        const totalCells = columns * rows;

        const cells = Array.from({ length: totalCells }, (_, index) => ({
            index,
            col: index % columns,
            row: Math.floor(index / columns),
            windSpeed: new Array(WIND_ALTITUDES_FT.length).fill(0),
            windDirection: new Array(WIND_ALTITUDES_FT.length).fill(0)
        }));

        const int32Array = new Int32Array(buffer);
        const uint32Array = new Uint32Array(buffer);
        const float32Array = new Float32Array(buffer);

        const readLayerFromOffset = (sourceArray, startOffset, setter) => {
            if (!Number.isFinite(startOffset) || startOffset <= 0) return false;
            if (startOffset + totalCells > sourceArray.length) return false;
            for (let idx = 0; idx < totalCells; idx += 1) {
                setter(cells[idx], sourceArray[startOffset + idx], idx);
            }
            return true;
        };

        const readWindLayer = (startOffset, setter) => {
            if (!Number.isFinite(startOffset) || startOffset <= 0) return false;
            const valuesPerCell = WIND_ALTITUDES_FT.length;
            if (startOffset + totalCells * valuesPerCell > float32Array.length) return false;
            for (let y = 0; y < rows; y += 1) {
                for (let x = 0; x < columns; x += 1) {
                    const cellIndex = y * columns + x;
                    const cellOffset = startOffset + (y * columns * valuesPerCell) + (x * valuesPerCell);
                    for (let alt = 0; alt < valuesPerCell; alt += 1) {
                        setter(cells[cellIndex], alt, float32Array[cellOffset + alt]);
                    }
                }
            }
            return true;
        };

        if (!readLayerFromOffset(int32Array, FMAP_LAYER_OFFSETS.weatherType, (cell, value) => { cell.weatherClass = value; })) {
            throw new Error('Invalid FMAP: missing weather classification layer');
        }

        if (!readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.pressure, (cell, value) => { cell.pressureMb = value; })) {
            throw new Error('Invalid FMAP: missing pressure layer');
        }

        if (!readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.temperature, (cell, value) => { cell.temperatureC = value; })) {
            throw new Error('Invalid FMAP: missing temperature layer');
        }

        readWindLayer(FMAP_LAYER_OFFSETS.windSpeed, (cell, altitudeIndex, value) => {
            cell.windSpeed[altitudeIndex] = value;
        });

        readWindLayer(FMAP_LAYER_OFFSETS.windDirection, (cell, altitudeIndex, value) => {
            cell.windDirection[altitudeIndex] = value;
        });

        readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.cloudBase, (cell, value) => {
            cell.cloudBaseFt = value;
        });

        readLayerFromOffset(uint32Array, FMAP_LAYER_OFFSETS.cloudCover, (cell, value) => {
            cell.cloudCoverageIndex = value;
        });

        readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.cloudSize, (cell, value) => {
            // Treat the "size" metric as a proxy for depth (scale to feet for styling)
            cell.cloudDepthFt = value * 1000;
        });

        readLayerFromOffset(uint32Array, FMAP_LAYER_OFFSETS.cloudType, (cell, value) => {
            cell.cloudTypeIndex = value;
            cell.hasStorm = value === 1;
        });

        const showerOffset = VERSION_DATA_OFFSETS.shower[version] ?? 0;
        if (!readLayerFromOffset(uint32Array, showerOffset, (cell, value) => {
            cell.hasRain = value === 1;
        })) {
            cells.forEach(cell => { cell.hasRain = false; });
        }

        const visibilityOffset = VERSION_DATA_OFFSETS.visibility[version] ?? 0;
        if (visibilityOffset > 0) {
            readLayerFromOffset(float32Array, visibilityOffset, (cell, value) => {
                cell.visibilityKm = value;
            });
        }

        const fogOffset = VERSION_DATA_OFFSETS.fog[version] ?? 0;
        if (fogOffset > 0) {
            readLayerFromOffset(float32Array, fogOffset, (cell, value) => {
                cell.fogBaseFt = value;
            });
        }

        cells.forEach(cell => {
            if (typeof cell.hasStorm !== 'boolean') {
                cell.hasStorm = false;
            }
            if (typeof cell.hasRain !== 'boolean') {
                cell.hasRain = false;
            }
            if (typeof cell.precipAmount !== 'number') {
                cell.precipAmount = cell.hasRain ? 5 : 0;
            }
        });

        return {
            version,
            nodeCount,
            columns,
            rows,
            cellSpacingKm,
            anchor,
            cells
        };
    }

    class WeatherLayerManager {
        constructor() {
            this.map = null;
            this.data = null;
            this.filename = '';
            this.windAltitudeIndex = 0;
            this.uiBound = false;
            this.temperatureRange = { min: 0, max: 0 };
            this.precipMax = 1;
            this.mapSize = 16384;
            this.cellWidth = 0;
            this.cellHeight = 0;
            this.cellDiag = 0;
            this.windBarbScale = 1;
            this.dopplerCache = new Map();
            this.windBarbCache = new Map();
            this.cloudSpriteCache = new Map();
            this.debugEnabled = false;
            this.debugOverlay = null;
            this.debugElement = null;
            this.debugPointerMoveHandler = null;
            this.debugMouseLeaveHandler = null;

            this.layers = {
                weatherType: new ol.layer.Vector({
                    source: new ol.source.Vector(),
                    visible: false,
                    zIndex: 5,
                    style: this.createWeatherTypeStyle.bind(this)
                }),
                clouds: new ol.layer.Vector({
                    source: new ol.source.Vector(),
                    visible: false,
                    zIndex: 12,
                    style: this.createCloudStyle.bind(this)
                }),
                wind: new ol.layer.Vector({
                    source: new ol.source.Vector(),
                    visible: false,
                    zIndex: 30,
                    style: this.createWindStyle.bind(this)
                }),
                temperature: new ol.layer.Vector({
                    source: new ol.source.Vector(),
                    visible: false,
                    declutter: true,
                    zIndex: 40,
                    style: this.createTemperatureStyle.bind(this)
                })
            };

            this.ui = {
                fileInput: null,
                clearButton: null,
                status: null,
                toggles: {},
                windSelect: null,
                debugToggle: null
            };
        }

        bindMap(map) {
            if (this.map && this.map !== map) {
                this.setDebugEnabled(false, true);
                Object.values(this.layers).forEach(layer => this.map.removeLayer(layer));
                this.clear(false);
            }

            this.map = map;
            Object.values(this.layers).forEach(layer => {
                if (!map.getLayers().getArray().includes(layer)) {
                    map.addLayer(layer);
                }
            });
        }

        attachUI() {
            if (this.uiBound) return;

            this.ui.fileInput = document.getElementById('weather-loader');
            this.ui.clearButton = document.getElementById('weather-clear');
            this.ui.status = document.getElementById('weather-status');
            this.ui.toggles.temperature = document.getElementById('weather-toggle-temp');
            this.ui.toggles.wind = document.getElementById('weather-toggle-wind');
            this.ui.toggles.clouds = document.getElementById('weather-toggle-clouds');
            this.ui.toggles.weatherType = document.getElementById('weather-toggle-type');
            this.ui.windSelect = document.getElementById('weather-wind-altitude');
            this.ui.debugToggle = document.getElementById('weather-toggle-debug');

            this.ui.fileInput?.addEventListener('change', (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    try {
                        this.loadFromArrayBuffer(reader.result, file.name);
                    } catch (error) {
                        console.error('FMAP import failed:', error);
                        this.updateStatus('Unable to parse .fmap file.', true);
                    }
                    event.target.value = '';
                };
                reader.onerror = () => {
                    console.error('FMAP import failed:', reader.error);
                    this.updateStatus('Unable to read .fmap file.', true);
                    event.target.value = '';
                };
                reader.readAsArrayBuffer(file);
            });

            this.ui.clearButton?.addEventListener('click', () => this.clear(true));

            Object.entries(this.ui.toggles).forEach(([key, input]) => {
                input?.addEventListener('change', (event) => {
                    this.toggleLayer(key, event.target.checked);
                });
            });

            this.ui.debugToggle?.addEventListener('change', (event) => {
                if (!this.data) {
                    event.target.checked = false;
                    return;
                }
                this.setDebugEnabled(event.target.checked);
            });

            this.ui.windSelect?.addEventListener('change', (event) => {
                this.setWindAltitude(Number(event.target.value));
            });

            this.toggleControls(false);
            this.updateStatus('No weather imported');
            this.uiBound = true;
        }

        updateStatus(text, isError = false) {
            if (!this.ui.status) return;
            this.ui.status.textContent = text;
            this.ui.status.classList.toggle('is-error', isError);
        }

        toggleControls(enabled) {
            const inputs = [
                this.ui.clearButton,
                this.ui.windSelect,
                ...Object.values(this.ui.toggles),
                this.ui.debugToggle
            ].filter(Boolean);

            inputs.forEach(ctrl => {
                ctrl.disabled = !enabled;
                if (!enabled && ctrl.type === 'checkbox') {
                    ctrl.checked = false;
                }
            });

            if (!enabled && this.ui.windSelect) {
                this.ui.windSelect.value = '0';
            }

            if (!enabled) {
                this.setDebugEnabled(false, true);
            } else {
                this.setDebugEnabled(this.debugEnabled);
            }
        }

        toggleLayer(key, isEnabled) {
            const layer = this.layers[key];
            if (!layer) return;
            layer.setVisible(Boolean(this.data) && isEnabled);
            if (key === 'wind') layer.changed();
        }

        setWindAltitude(index) {
            this.windAltitudeIndex = clamp(index, 0, WIND_ALTITUDES_FT.length - 1);
            this.layers.wind.changed();
        }

        setDebugEnabled(enabled, forceDisable = false) {
            if (!forceDisable) {
                this.debugEnabled = Boolean(enabled);
            }

            if (this.ui.debugToggle) {
                this.ui.debugToggle.checked = this.debugEnabled;
                this.ui.debugToggle.disabled = !this.data;
            }

            if (!this.map) return;

            const shouldActivate = this.debugEnabled && this.data && !forceDisable;

            if (!shouldActivate) {
                this.hideDebugPopup();
                if (this.debugOverlay) {
                    this.map.removeOverlay(this.debugOverlay);
                    this.debugOverlay = null;
                    this.debugElement = null;
                }
                if (this.debugPointerMoveHandler) {
                    this.map.un('pointermove', this.debugPointerMoveHandler);
                    this.debugPointerMoveHandler = null;
                }
                if (this.debugMouseLeaveHandler) {
                    this.map.getViewport().removeEventListener('mouseleave', this.debugMouseLeaveHandler);
                    this.debugMouseLeaveHandler = null;
                }
                return;
            }

            if (!this.debugElement) {
                this.debugElement = document.createElement('div');
                this.debugElement.className = 'weather-debug-popup';
            }

            if (!this.debugOverlay) {
                this.debugOverlay = new ol.Overlay({
                    element: this.debugElement,
                    offset: [16, -16],
                    positioning: 'bottom-left',
                    stopEvent: false
                });
                this.map.addOverlay(this.debugOverlay);
            }

            if (!this.debugPointerMoveHandler) {
                this.debugPointerMoveHandler = (evt) => {
                    if (!evt.coordinate || evt.dragging) return;
                    const cell = this.getCellAtCoordinate(evt.coordinate);
                    if (!cell) {
                        this.hideDebugPopup();
                        return;
                    }
                    this.updateDebugPopup(cell, evt.coordinate);
                };
                this.map.on('pointermove', this.debugPointerMoveHandler);
            }

            if (!this.debugMouseLeaveHandler) {
                this.debugMouseLeaveHandler = () => this.hideDebugPopup();
                this.map.getViewport().addEventListener('mouseleave', this.debugMouseLeaveHandler, { passive: true });
            }
        }

        getCellAtCoordinate(coord) {
            if (!this.data || !this.cellWidth || !this.cellHeight) return null;
            const [x, y] = coord;
            if (x < 0 || y < 0 || x > this.mapSize || y > this.mapSize) return null;
            const col = Math.floor(x / this.cellWidth);
            const row = Math.floor((this.mapSize - y) / this.cellHeight);
            if (col < 0 || row < 0 || col >= this.data.columns || row >= this.data.rows) return null;
            return this.data.cells[row * this.data.columns + col];
        }

        hideDebugPopup() {
            if (this.debugElement) {
                this.debugElement.classList.remove('is-visible');
            }
        }

        updateDebugPopup(cell, coordinate) {
            if (!this.debugElement || !this.debugOverlay) return;
            const altitudeFt = WIND_ALTITUDES_FT[this.windAltitudeIndex] || 0;
            const altitudeLabel = altitudeFt >= 1000 ? `${(altitudeFt / 1000).toFixed(0)}kft` : `${altitudeFt}ft`;
            const windSpeed = cell.windSpeed?.[this.windAltitudeIndex];
            const windDir = cell.windDirection?.[this.windAltitudeIndex];

            const lines = [
                `<div><strong>Cell</strong>${cell.col}, ${cell.row}</div>`,
                `<div><strong>Temp</strong>${Number.isFinite(cell.temperatureC) ? `${cell.temperatureC.toFixed(1)} °C` : 'N/A'}</div>`,
                `<div><strong>Pressure</strong>${Number.isFinite(cell.pressureMb) ? `${cell.pressureMb.toFixed(0)} hPa` : 'N/A'}</div>`,
                `<div><strong>Wind ${altitudeLabel}</strong>${Number.isFinite(windDir) ? windDir.toFixed(0) : '---'}° @ ${Number.isFinite(windSpeed) ? windSpeed.toFixed(0) : '---'} kt</div>`,
                `<div><strong>Clouds</strong>${cell.cloudCoverageIndex ?? 'N/A'} / ${cell.cloudBaseFt ? `${(cell.cloudBaseFt / 1000).toFixed(1)}kft` : 'N/A'}</div>`,
                `<div><strong>Rain</strong>${cell.hasRain ? 'Yes' : 'No'}</div>`
            ];

            this.debugElement.innerHTML = lines.join('');
            this.debugElement.classList.add('is-visible');
            this.debugOverlay.setPosition(coordinate);
        }

        clear(showMessage) {
            Object.values(this.layers).forEach(layer => layer.getSource().clear());
            Object.values(this.layers).forEach(layer => layer.setVisible(false));
            this.data = null;
            this.filename = '';
            this.dopplerCache.clear();
            this.toggleControls(false);
            if (showMessage) {
                this.updateStatus('Weather overlay cleared');
            } else {
                this.updateStatus('No weather imported');
            }
        }

        loadFromArrayBuffer(buffer, filename) {
            const parsed = parseFmap(buffer);
            this.data = parsed;
            this.filename = filename;
            this.buildFeatures();
            this.toggleControls(true);

            // Enable defaults
            ['weatherType'].forEach(key => {
                const checkbox = this.ui.toggles[key];
                if (checkbox) {
                    checkbox.checked = true;
                    this.toggleLayer(key, true);
                }
            });
            ['wind'].forEach(key => {
                const checkbox = this.ui.toggles[key];
                if (checkbox) {
                    checkbox.checked = false;
                    this.toggleLayer(key, false);
                }
            });

            if (this.ui.debugToggle) {
                this.ui.debugToggle.disabled = false;
            }
            this.setDebugEnabled(this.debugEnabled);

            const info = `${parsed.columns}x${parsed.rows} grid (${filename})`;
            this.updateStatus(`Loaded ${info}`);
        }

        buildFeatures() {
            if (!this.map || !this.data) return;

            const settings = window.getCurrentTheaterSettings?.() || { size: 16384 };
            this.mapSize = settings.size;
            this.cellWidth = this.mapSize / this.data.columns;
            this.cellHeight = this.mapSize / this.data.rows;
            this.cellDiag = Math.hypot(this.cellWidth, this.cellHeight);
            this.windBarbScale = clamp(this.cellDiag / 260, 0.35, 0.85);

            const tempSource = this.layers.temperature.getSource();
            const windSource = this.layers.wind.getSource();
            const cloudSource = this.layers.clouds.getSource();
            const weatherTypeSource = this.layers.weatherType.getSource();

            tempSource.clear();
            windSource.clear();
            cloudSource.clear();
            weatherTypeSource.clear();

            const tempFeatures = [];
            const windFeatures = [];
            const cloudFeatures = [];
            const weatherTypeFeatures = [];

            let minTemp = Infinity;
            let maxTemp = -Infinity;
            let maxPrecip = 0;

            for (const cell of this.data.cells) {
                const center = [
                    (cell.col + 0.5) * this.cellWidth,
                    this.mapSize - ((cell.row + 0.5) * this.cellHeight)
                ];

                const sampledPoint = (cell.col % SAMPLE_STEP === 0) && (cell.row % SAMPLE_STEP === 0);

                if (Number.isFinite(cell.temperatureC)) {
                    minTemp = Math.min(minTemp, cell.temperatureC);
                    maxTemp = Math.max(maxTemp, cell.temperatureC);

                    if (sampledPoint) {
                        const tempFeature = new ol.Feature({
                            geometry: new ol.geom.Point(center),
                            temperature: cell.temperatureC,
                            weatherClass: cell.weatherClass
                        });
                        tempFeatures.push(tempFeature);
                    }
                }

                if (sampledPoint) {
                    const vectors = cell.windSpeed.map((speed, idx) => ({
                        altitudeFt: WIND_ALTITUDES_FT[idx],
                        speed,
                        direction: cell.windDirection[idx]
                    }));

                    const windFeature = new ol.Feature({
                        geometry: new ol.geom.Point(center),
                        vectors
                    });
                    windFeatures.push(windFeature);
                }

                if (cell.cloudCoverageIndex > 0) {
                    const normalizedCoverageIndex = (cell.cloudCoverageIndex - 2) / 11;
                    const coverageNormalized = clamp(normalizedCoverageIndex, 0, 1);
                    if (coverageNormalized <= 0.02 && !cell.hasStorm) {
                        continue;
                    }
                    const cloudFeature = new ol.Feature({
                        geometry: new ol.geom.Point(center),
                        coverage: coverageNormalized,
                        cloudType: cell.cloudTypeIndex,
                        cloudTypeLabel: CLOUD_TYPES[cell.cloudTypeIndex] || 'Clouds',
                        hasStorm: cell.hasStorm,
                        baseFt: cell.cloudBaseFt,
                        depthFt: cell.cloudDepthFt,
                        cloudScale: 0.35 + coverageNormalized * 0.65
                    });
                    cloudFeatures.push(cloudFeature);
                }

                if (cell.weatherClass && cell.weatherClass > 1) {
                    const polygon = new ol.geom.Polygon([this.getCellPolygon(cell.col, cell.row)]);
                    const typeFeature = new ol.Feature({
                        geometry: polygon,
                        weatherClass: cell.weatherClass
                    });
                    weatherTypeFeatures.push(typeFeature);
                }
            }

            this.temperatureRange = {
                min: Number.isFinite(minTemp) ? minTemp : 0,
                max: Number.isFinite(maxTemp) ? maxTemp : 0
            };


            tempSource.addFeatures(tempFeatures);
            windSource.addFeatures(windFeatures);
            cloudSource.addFeatures(cloudFeatures);
            weatherTypeSource.addFeatures(weatherTypeFeatures);
        }

        createTemperatureStyle(feature, resolution) {
            if (!this.data || resolution > 30) return null;

            const temp = feature.get('temperature');
            if (!Number.isFinite(temp)) return null;

            const weatherClass = WEATHER_CLASSES[feature.get('weatherClass')];
            const color = this.getTemperatureColor(temp);
            const fontSize = Math.max(11, 18 - (resolution * 1.4));

            return new ol.style.Style({
                text: new ol.style.Text({
                    text: `${Math.round(temp)}°`,
                    font: `600 ${fontSize}px 'Segoe UI', sans-serif`,
                    fill: new ol.style.Fill({ color }),
                    stroke: new ol.style.Stroke({ color: 'rgba(12,12,12,0.75)', width: 3 }),
                    offsetY: -2
                })
            });
        }

        getCellPolygon(col, row) {
            const minX = col * this.cellWidth;
            const maxX = minX + this.cellWidth;
            const topY = this.mapSize - (row * this.cellHeight);
            const bottomY = topY - this.cellHeight;
            return [
                [minX, bottomY],
                [maxX, bottomY],
                [maxX, topY],
                [minX, topY],
                [minX, bottomY]
            ];
        }

        createWeatherTypeStyle(feature) {
            const weatherClass = feature.get('weatherClass');
            const colors = {
                2: 'rgba(34,197,94,0.5)',
                3: 'rgba(250,204,21,0.5)',
                4: 'rgba(239,68,68,0.5)'
            };
            const fillColor = colors[weatherClass];
            if (!fillColor) return null;
            return new ol.style.Style({
                fill: new ol.style.Fill({ color: fillColor })
            });
        }

        getTemperatureColor(value) {
            if (!Number.isFinite(value)) return '#ffffff';
            const bands = [
                { max: -10, color: '#4338ca' }, // deep blue
                { max: -5, color: '#2563eb' },
                { max: 0, color: '#0ea5e9' },
                { max: 5, color: '#10b981' },
                { max: 10, color: '#34d399' },
                { max: 15, color: '#facc15' },
                { max: 20, color: '#f97316' },
                { max: 25, color: '#ea580c' }
            ];
            const band = bands.find(b => value <= b.max);
            return band?.color ?? '#ef4444';
        }

        createWindStyle(feature, resolution) {
            if (!this.data || resolution > 45) return null;

            const vectors = feature.get('vectors');
            if (!vectors) return null;

            const vector = vectors[this.windAltitudeIndex];
            if (!vector || !Number.isFinite(vector.speed) || !Number.isFinite(vector.direction)) return null;

            const sprite = this.getWindBarbSprite(vector.speed);
            if (!sprite) return null;

            const rotationDegrees = (180 + vector.direction) % 360;
            const rotation = (rotationDegrees * Math.PI) / 180;

            const imgSize = sprite.imgSize || [sprite.size, sprite.size];
            const anchor = sprite.anchor || [0.5, 0.85];
            const scale = sprite.scale ?? 1;

            return new ol.style.Style({
                image: new ol.style.Icon({
                    img: sprite.canvas,
                    imgSize,
                    rotation,
                    rotateWithView: true,
                    anchor,
                    scale: this.windBarbScale * scale
                })
            });
        }

        createCloudStyle(feature, resolution) {
            if (!this.data || resolution > 120) return null;
            const coverage = feature.get('coverage') ?? 0;
            if (coverage <= 0.02) return null;

            const typeIndex = feature.get('cloudType');
            const hasStorm = feature.get('hasStorm') || typeIndex === 5;
            const sprite = this.getCloudSprite(coverage, hasStorm);
            if (!sprite) return null;

            const featureScale = feature.get('cloudScale') || 1;
            const targetFootprint = this.cellDiag * featureScale * (0.85 + coverage * 1.2);
            const resolutionAdjustedScale = targetFootprint / (sprite.size * Math.max(resolution, 0.5));
            const finalScale = clamp(resolutionAdjustedScale, 0.45, 5);
            const zoomOpacityFactor = clamp((45 - Math.min(45, resolution)) / 260, -0.04, 0.06);
            const opacity = clamp(0.4 + (coverage * 0.2) + zoomOpacityFactor, 0.09, 0.34);

            return new ol.style.Style({
                image: new ol.style.Icon({
                    img: sprite.canvas,
                    imgSize: [sprite.size, sprite.size],
                    scale: finalScale,
                    opacity
                })
            });
        }

        createRainStyle(feature, resolution) {
            if (!this.data || resolution > 45) return null;

            const bucket = feature.get('bucket');
        }

        getWindBarbSprite(speed) {
            const normalizedSpeed = Math.max(0, Math.round(speed / 5) * 5);
            const bucketKey = `barb-${normalizedSpeed}`;
            if (this.windBarbCache.has(bucketKey)) {
                return this.windBarbCache.get(bucketKey);
            }

            const width = 110;
            const height = 70;
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            ctx.translate(width / 2, height * 0.15);
            const barbColor = '#111827';
            ctx.strokeStyle = barbColor;
            ctx.fillStyle = barbColor;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';

            if (normalizedSpeed < 5) {
                ctx.beginPath();
                ctx.arc(0, height * 0.6, height * 0.08, 0, Math.PI * 2);
                ctx.fill();
                const sprite = {
                    canvas,
                    imgSize: [width, height],
                    anchor: [0.5, 0.15],
                    scale: 0.65
                };
                this.windBarbCache.set(bucketKey, sprite);
                return sprite;
            }

            const shaftLength = height * 0.75;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, shaftLength);
            ctx.stroke();

            let remaining = normalizedSpeed;
            const spacing = height * 0.12;
            let y = spacing;
            const barbLength = width * 0.28;

            const drawFlag = () => {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(-barbLength, y - spacing);
                ctx.lineTo(0, y - spacing * 2);
                ctx.closePath();
                ctx.fill();
                y += spacing * 1.2;
            };

            const drawFull = () => {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(-barbLength * 0.85, y - spacing * 0.7);
                ctx.stroke();
                y += spacing;
            };

            const drawHalf = () => {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(-barbLength * 0.5, y - spacing * 0.4);
                ctx.stroke();
                y += spacing;
            };

            const flags = Math.floor(remaining / 50);
            remaining -= flags * 50;
            const fulls = Math.floor(remaining / 10);
            remaining -= fulls * 10;
            const halves = Math.floor(remaining / 5);

            for (let i = 0; i < flags; i += 1) drawFlag();
            for (let i = 0; i < fulls; i += 1) drawFull();
            for (let i = 0; i < halves; i += 1) drawHalf();

            const sprite = {
                canvas,
                imgSize: [width, height],
                anchor: [0.5, 0.15],
                scale: 0.75
            };
            this.windBarbCache.set(bucketKey, sprite);
            return sprite;
        }

        getCloudSprite(coverage, hasStorm) {
            const bucket = `${Math.round(coverage * 10)}-${hasStorm ? 1 : 0}`;
            if (this.cloudSpriteCache.has(bucket)) {
                return this.cloudSpriteCache.get(bucket);
            }

            const size = 256;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext('2d');

            ctx.clearRect(0, 0, size, size);
            ctx.globalCompositeOperation = 'lighter';

            const layers = hasStorm ? 6 : 4;
            for (let i = 0; i < layers; i += 1) {
                const radiusScale = 0.35 + (i / layers) * 0.4;
                const alpha = (0.1 + coverage * 0.18) * (1 - i / layers);
                const radius = size * radiusScale;
                const x = (size / 2) + (Math.cos(i * 1.7) * size * 0.05);
                const y = (size / 2) + (Math.sin(i * 2.1) * size * 0.05);

                const gradient = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius);
                const baseColor = hasStorm ? [210, 225, 255] : [245, 248, 255];
                gradient.addColorStop(0, `rgba(${baseColor[0]},${baseColor[1]},${baseColor[2]},${alpha * 1.35})`);
                gradient.addColorStop(0.6, `rgba(${baseColor[0]},${baseColor[1]},${baseColor[2]},${alpha * 0.6})`);
                gradient.addColorStop(1, `rgba(${baseColor[0]},${baseColor[1]},${baseColor[2]},0)`);

                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.globalCompositeOperation = 'source-over';
            const sprite = { canvas, size };
            this.cloudSpriteCache.set(bucket, sprite);
            return sprite;
        }
    }

    function initWeatherModule(map) {
        if (!window.weatherLayerManager) {
            window.weatherLayerManager = new WeatherLayerManager();
            window.weatherLayerManager.attachUI();
        }
        window.weatherLayerManager.bindMap(map);
        return window.weatherLayerManager;
    }

    window.initWeatherModule = initWeatherModule;
})();

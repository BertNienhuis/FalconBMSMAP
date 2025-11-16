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
        shower:     [0, 0, 0, 0, 0, 0, 0, 0, 93998, 93998],
        visibility: [0, 0, 0, 0, 0, 93998, 93998, 93998, 97479, 97479],
        fog:        [0, 0, 0, 0, 0, 0, 0, 0, 100960, 100960]
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

        const createGrid = (initialValue = null) =>
            Array.from({ length: rows }, () => Array.from({ length: columns }, () => initialValue));

        const createWindGrid = () =>
            Array.from({ length: rows }, () =>
                Array.from({ length: columns }, () =>
                    Array.from({ length: WIND_ALTITUDES_FT.length }, () => ({ direction: null, speed: null }))
                )
            );

        const fmap = {
            time: '',
            version,
            changed: false,
            scaler: cellSpacingKm,
            dimension: { x: columns, y: rows },
            airmass: { direction: 0, speed: 0 },
            turbulence: { top: null, bottom: null },
            contrail: [],
            cells: totalCells,
            type: createGrid(0),
            pressure: createGrid(null),
            temperature: createGrid(null),
            wind: createWindGrid(),
            cloud: {
                base: createGrid(null),
                cover: createGrid(0),
                size: createGrid(null),
                type: createGrid(0)
            },
            shower: createGrid(0),
            visibility: createGrid(null),
            fog: createGrid(null),
            analytics: {
                pressure_min: Infinity,
                pressure_max: -Infinity,
                temperature_min: Infinity,
                temperature_max: -Infinity
            }
        };

        const airmassAccumulator = { x: 0, y: 0, samples: 0 };

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

        if (!readLayerFromOffset(int32Array, FMAP_LAYER_OFFSETS.weatherType, (cell, value) => {
            cell.weatherClass = value;
            fmap.type[cell.row][cell.col] = value;
        })) {
            throw new Error('Invalid FMAP: missing weather classification layer');
        }

        if (!readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.pressure, (cell, value) => {
            cell.pressureMb = value;
            fmap.pressure[cell.row][cell.col] = value;
            if (Number.isFinite(value)) {
                fmap.analytics.pressure_min = Math.min(fmap.analytics.pressure_min, value);
                fmap.analytics.pressure_max = Math.max(fmap.analytics.pressure_max, value);
            }
        })) {
            throw new Error('Invalid FMAP: missing pressure layer');
        }

        if (!readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.temperature, (cell, value) => {
            cell.temperatureC = value;
            fmap.temperature[cell.row][cell.col] = value;
            if (Number.isFinite(value)) {
                fmap.analytics.temperature_min = Math.min(fmap.analytics.temperature_min, value);
                fmap.analytics.temperature_max = Math.max(fmap.analytics.temperature_max, value);
            }
        })) {
            throw new Error('Invalid FMAP: missing temperature layer');
        }

        readWindLayer(FMAP_LAYER_OFFSETS.windSpeed, (cell, altitudeIndex, value) => {
            cell.windSpeed[altitudeIndex] = value;
            const windSlot = fmap.wind[cell.row]?.[cell.col]?.[altitudeIndex];
            if (windSlot) {
                windSlot.speed = value;
            }
        });

        readWindLayer(FMAP_LAYER_OFFSETS.windDirection, (cell, altitudeIndex, value) => {
            cell.windDirection[altitudeIndex] = value;
            const windSlot = fmap.wind[cell.row]?.[cell.col]?.[altitudeIndex];
            if (windSlot) {
                windSlot.direction = value;
            }
            if (altitudeIndex === 0) {
                const surfaceSpeed = cell.windSpeed?.[altitudeIndex];
                if (Number.isFinite(surfaceSpeed) && Number.isFinite(value)) {
                    const radians = (value * Math.PI) / 180;
                    airmassAccumulator.x += surfaceSpeed * Math.sin(radians);
                    airmassAccumulator.y += surfaceSpeed * Math.cos(radians);
                    airmassAccumulator.samples += 1;
                }
            }
        });

        readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.cloudBase, (cell, value) => {
            cell.cloudBaseFt = value;
            fmap.cloud.base[cell.row][cell.col] = value;
        });

        readLayerFromOffset(uint32Array, FMAP_LAYER_OFFSETS.cloudCover, (cell, value) => {
            cell.cloudCoverageIndex = value;
            fmap.cloud.cover[cell.row][cell.col] = value;
        });

        readLayerFromOffset(float32Array, FMAP_LAYER_OFFSETS.cloudSize, (cell, value) => {
            // Treat the "size" metric as a proxy for depth (scale to feet for styling)
            cell.cloudDepthFt = value * 1000;
            fmap.cloud.size[cell.row][cell.col] = value;
        });

        readLayerFromOffset(uint32Array, FMAP_LAYER_OFFSETS.cloudType, (cell, value) => {
            cell.cloudTypeIndex = value;
            cell.hasStorm = value === 1;
            fmap.cloud.type[cell.row][cell.col] = value;
        });

        const showerOffset = VERSION_DATA_OFFSETS.shower[version] ?? 0;
        if (!readLayerFromOffset(uint32Array, showerOffset, (cell, value) => {
            cell.hasRain = value === 1;
            fmap.shower[cell.row][cell.col] = value;
        })) {
            cells.forEach(cell => { cell.hasRain = false; });
        }

        const visibilityOffset = VERSION_DATA_OFFSETS.visibility[version] ?? 0;
        if (visibilityOffset > 0) {
            readLayerFromOffset(float32Array, visibilityOffset, (cell, value) => {
                cell.visibilityKm = value;
                fmap.visibility[cell.row][cell.col] = value;
            });
        }

        const fogOffset = VERSION_DATA_OFFSETS.fog[version] ?? 0;
        if (fogOffset > 0) {
            readLayerFromOffset(float32Array, fogOffset, (cell, value) => {
                cell.fogBaseFt = value;
                fmap.fog[cell.row][cell.col] = value;
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

        const finalizeRangeValue = value => (Number.isFinite(value) ? value : null);
        fmap.analytics.pressure_min = finalizeRangeValue(fmap.analytics.pressure_min);
        fmap.analytics.pressure_max = finalizeRangeValue(fmap.analytics.pressure_max);
        fmap.analytics.temperature_min = finalizeRangeValue(fmap.analytics.temperature_min);
        fmap.analytics.temperature_max = finalizeRangeValue(fmap.analytics.temperature_max);

        if (airmassAccumulator.samples > 0) {
            const avgX = airmassAccumulator.x / airmassAccumulator.samples;
            const avgY = airmassAccumulator.y / airmassAccumulator.samples;
            const avgSpeed = Math.hypot(avgX, avgY);
            const avgDir = (Math.atan2(avgX, avgY) * 180 / Math.PI + 360) % 360;
            fmap.airmass = {
                direction: avgDir,
                speed: avgSpeed
            };
        }

        return {
            version,
            nodeCount,
            columns,
            rows,
            cellSpacingKm,
            anchor,
            totalCells,
            cells,
            fmap
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
            this.mapSize = 16384;
            this.cellWidth = 0;
            this.cellHeight = 0;
            this.cellDiag = 0;
            this.windBarbScale = 1;
            this.windBarbCache = new Map();
            this.cloudSpriteCache = new Map();
            this.debugEnabled = false;
            this.debugOverlay = null;
            this.debugElement = null;
            this.debugPointerMoveHandler = null;
            this.debugMouseLeaveHandler = null;
            this.originalBuffer = null;
            this.downloadInProgress = false;

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
                exportButton: null,
                downloadButton: null,
                gfsDateInput: null,
                gfsCycleInput: null,
                gfsHourInput: null,
                status: null,
                toggles: {},
                windSelect: null,
                debugToggle: null
            };
        }

        bindMap(map) {
            if (this.map && this.map !== map) {
                this.setDebugEnabled(false, true);
                this.forEachLayer(layer => this.map.removeLayer(layer));
                this.clear(false);
            }

            this.map = map;
            const layersArray = map.getLayers().getArray();
            this.forEachLayer(layer => {
                if (!layersArray.includes(layer)) {
                    map.addLayer(layer);
                }
            });
        }

        attachUI() {
            if (this.uiBound) return;

            this.ui.fileInput = document.getElementById('weather-loader');
            this.ui.clearButton = document.getElementById('weather-clear');
            this.ui.exportButton = document.getElementById('weather-export');
            this.ui.downloadButton = document.getElementById('weather-download');
            this.ui.gfsDateInput = document.getElementById('weather-gfs-date');
            this.ui.gfsCycleInput = document.getElementById('weather-gfs-cycle');
            this.ui.gfsHourInput = document.getElementById('weather-gfs-hour');
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
            this.ui.exportButton?.addEventListener('click', () => this.exportFmap());
            this.ui.downloadButton?.addEventListener('click', () => this.handleDownloadWeather());

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
            this.initializeDownloadControls();
        }

        forEachLayer(callback) {
            if (!callback) return;
            Object.values(this.layers).forEach(callback);
        }

        setLayerToggle(key, checked) {
            const checkbox = this.ui.toggles[key];
            if (!checkbox) return;
            checkbox.checked = checked;
            this.toggleLayer(key, checked);
        }

        extractTimeFromFilename(filename) {
            if (!filename) return '';
            const normalized = filename.split(/[\\/]/).pop() || filename;
            const dotIndex = normalized.lastIndexOf('.');
            const base = dotIndex > 0 ? normalized.slice(0, dotIndex) : normalized;
            return base.trim();
        }

        updateStatus(text, isError = false) {
            if (!this.ui.status) return;
            this.ui.status.textContent = text;
            this.ui.status.classList.toggle('is-error', isError);
        }

        toggleControls(enabled) {
            const inputs = [
                this.ui.clearButton,
                this.ui.exportButton,
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

        clear(showMessage) {
            this.forEachLayer(layer => {
                layer.getSource().clear();
                layer.setVisible(false);
            });
            this.data = null;
            this.filename = '';
            this.originalBuffer = null;
            if (typeof window !== 'undefined') {
                window.fmap = null;
            }
            this.toggleControls(false);
            if (showMessage) {
                this.updateStatus('Weather overlay cleared');
            } else {
                this.updateStatus('No weather imported');
            }
        }

        loadFromArrayBuffer(buffer, filename) {
            const sourceBuffer = buffer instanceof ArrayBuffer
                ? buffer
                : buffer?.buffer;
            if (!(sourceBuffer instanceof ArrayBuffer)) {
                throw new Error('Invalid FMAP buffer');
            }

            this.originalBuffer = sourceBuffer.slice(0);
            const parsed = parseFmap(this.originalBuffer);
            this.data = parsed;
            if (parsed.fmap && filename) {
                const inferredTime = this.extractTimeFromFilename(filename);
                if (!parsed.fmap.time && inferredTime) {
                    parsed.fmap.time = inferredTime;
                }
            }
            if (typeof window !== 'undefined') {
                window.fmap = parsed.fmap;
            }
            this.filename = filename;
            this.buildFeatures();
            this.toggleControls(true);

            // Enable defaults
            this.setLayerToggle('weatherType', true);
            this.setLayerToggle('wind', false);

            if (this.ui.debugToggle) {
                this.ui.debugToggle.disabled = false;
            }
            this.setDebugEnabled(this.debugEnabled);

            const info = `${parsed.columns}x${parsed.rows} grid (${filename})`;
            this.updateStatus(`Loaded ${info}`);
        }

        getVersionOffset(key, version) {
            const table = VERSION_DATA_OFFSETS[key];
            if (!table || !table.length) return 0;
            const normalized = Number.isFinite(version) ? Math.round(version) : 0;
            const index = clamp(normalized, 0, table.length - 1);
            return table[index] || 0;
        }

        createFmapBuffer(sourceData) {
            const dataSource = sourceData || this.data;
            if (!dataSource?.fmap) return null;
            const fmap = dataSource.fmap;

            const columns = Number.isFinite(dataSource.columns)
                ? Math.trunc(dataSource.columns)
                : Math.trunc(fmap.dimension?.x ?? this.data?.columns ?? 0);
            const rows = Number.isFinite(dataSource.rows)
                ? Math.trunc(dataSource.rows)
                : Math.trunc(fmap.dimension?.y ?? this.data?.rows ?? 0);
            if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns <= 0 || rows <= 0) {
                return null;
            }

            const totalCells = columns * rows;
            const valuesPerCell = WIND_ALTITUDES_FT.length;
            const version = Number.isFinite(dataSource.version)
                ? Math.trunc(dataSource.version)
                : Math.trunc(fmap.version ?? 0);
            const airmassDirection = Number.isFinite(fmap.airmass?.direction)
                ? Math.trunc(fmap.airmass.direction)
                : 0;
            const airmassSpeed = Number.isFinite(fmap.airmass?.speed)
                ? fmap.airmass.speed
                : 0;
            const turbulenceTop = Number.isFinite(fmap.turbulence?.top)
                ? Math.trunc(fmap.turbulence.top)
                : 31000;
            const turbulenceBottom = Number.isFinite(fmap.turbulence?.bottom)
                ? Math.trunc(fmap.turbulence.bottom)
                : 28000;
            const contrails = Array.isArray(fmap.contrail) && fmap.contrail.length === 4
                ? fmap.contrail
                : [34000, 28000, 25000, 20000];

            const showerOffset = this.getVersionOffset('shower', version);
            const visibilityOffset = this.getVersionOffset('visibility', version);
            const fogOffset = this.getVersionOffset('fog', version);

            const offsetsToMeasure = [
                { offset: FMAP_LAYER_OFFSETS.weatherType, length: totalCells },
                { offset: FMAP_LAYER_OFFSETS.pressure, length: totalCells },
                { offset: FMAP_LAYER_OFFSETS.temperature, length: totalCells },
                { offset: FMAP_LAYER_OFFSETS.windSpeed, length: totalCells * valuesPerCell },
                { offset: FMAP_LAYER_OFFSETS.windDirection, length: totalCells * valuesPerCell },
                { offset: FMAP_LAYER_OFFSETS.cloudBase, length: totalCells },
                { offset: FMAP_LAYER_OFFSETS.cloudCover, length: totalCells },
                { offset: FMAP_LAYER_OFFSETS.cloudSize, length: totalCells },
                { offset: FMAP_LAYER_OFFSETS.cloudType, length: totalCells }
            ];

            [showerOffset, visibilityOffset, fogOffset].forEach(offset => {
                if (offset > 0) {
                    offsetsToMeasure.push({ offset, length: totalCells });
                }
            });

            let requiredUnits = FMAP_LAYER_OFFSETS.weatherType;
            offsetsToMeasure.forEach(({ offset, length }) => {
                if (Number.isFinite(offset) && offset > 0) {
                    requiredUnits = Math.max(requiredUnits, offset + length);
                }
            });

            const buffer = new ArrayBuffer(requiredUnits * 4);
            const view = new DataView(buffer);
            let headerOffset = 0;
            const writeInt32 = (value) => {
                const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
                view.setInt32(headerOffset, normalized, true);
                headerOffset += 4;
            };
            const writeFloat32 = (value) => {
                const normalized = Number.isFinite(value) ? value : 0;
                view.setFloat32(headerOffset, normalized, true);
                headerOffset += 4;
            };

            writeInt32(version);
            writeInt32(columns);
            writeInt32(rows);
            writeInt32(airmassDirection);
            writeFloat32(airmassSpeed);
            writeInt32(turbulenceTop);
            writeInt32(turbulenceBottom);
            for (let i = 0; i < 4; i += 1) {
                writeInt32(Number(contrails[i]) || 0);
            }

            const int32Array = new Int32Array(buffer);
            const uint32Array = new Uint32Array(buffer);
            const float32Array = new Float32Array(buffer);

            const getGridValue = (grid, row, col) => grid?.[row]?.[col];
            const toFloat = (value) => {
                const asNumber = Number(value ?? 0);
                return Number.isNaN(asNumber) ? 0 : asNumber;
            };
            const toInt = (value) => {
                const asNumber = Number(value ?? 0);
                return Number.isNaN(asNumber) ? 0 : Math.trunc(asNumber);
            };
            const toUInt = (value) => {
                const asNumber = Number(value ?? 0);
                if (!Number.isFinite(asNumber) || asNumber < 0) return 0;
                return Math.trunc(asNumber);
            };

            for (let row = 0; row < rows; row += 1) {
                for (let col = 0; col < columns; col += 1) {
                    const idx = row * columns + col;
                    int32Array[FMAP_LAYER_OFFSETS.weatherType + idx] = toInt(getGridValue(fmap.type, row, col));
                    float32Array[FMAP_LAYER_OFFSETS.pressure + idx] = toFloat(getGridValue(fmap.pressure, row, col));
                    float32Array[FMAP_LAYER_OFFSETS.temperature + idx] = toFloat(getGridValue(fmap.temperature, row, col));

                    const windSlot = fmap.wind?.[row]?.[col] || [];
                    const windSpeedStart = FMAP_LAYER_OFFSETS.windSpeed + (idx * valuesPerCell);
                    const windDirStart = FMAP_LAYER_OFFSETS.windDirection + (idx * valuesPerCell);
                    for (let alt = 0; alt < valuesPerCell; alt += 1) {
                        const entry = windSlot[alt];
                        float32Array[windSpeedStart + alt] = toFloat(entry?.speed);
                        float32Array[windDirStart + alt] = toFloat(entry?.direction);
                    }

                    float32Array[FMAP_LAYER_OFFSETS.cloudBase + idx] = toFloat(getGridValue(fmap.cloud?.base, row, col));
                    uint32Array[FMAP_LAYER_OFFSETS.cloudCover + idx] = toUInt(getGridValue(fmap.cloud?.cover, row, col));
                    float32Array[FMAP_LAYER_OFFSETS.cloudSize + idx] = toFloat(getGridValue(fmap.cloud?.size, row, col));
                    uint32Array[FMAP_LAYER_OFFSETS.cloudType + idx] = toUInt(getGridValue(fmap.cloud?.type, row, col));

                    if (showerOffset > 0) {
                        uint32Array[showerOffset + idx] = toUInt(getGridValue(fmap.shower, row, col));
                    }
                    if (visibilityOffset > 0) {
                        float32Array[visibilityOffset + idx] = toFloat(getGridValue(fmap.visibility, row, col));
                    }
                    if (fogOffset > 0) {
                        float32Array[fogOffset + idx] = toFloat(getGridValue(fmap.fog, row, col));
                    }
                }
            }

            return buffer;
        }

        buildExportFilename(prefix = '') {
            const existing = (this.filename || '').trim();
            if (existing) {
                const normalized = existing.toLowerCase();
                if (normalized.endsWith('.fmap')) return existing;
                return `${existing}.fmap`;
            }
            const label = (this.data?.fmap?.time || '').trim();
            if (label) {
                const slug = label.replace(/\s+/g, '_');
                return `${slug}.fmap`;
            }
            const base = prefix ? `${prefix}-weather` : 'weather-export';
            return `${base}.fmap`;
        }

        downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
        }

        exportFmap() {
            if (!this.data?.fmap) {
                this.updateStatus('No weather data to export.', true);
                return;
            }
            try {
                const buffer = this.createFmapBuffer();
                if (!buffer) {
                    this.updateStatus('Unable to build .fmap file.', true);
                    return;
                }
                const blob = new Blob([buffer], { type: 'application/octet-stream' });
                const filename = this.buildExportFilename();
                this.downloadBlob(blob, filename);
                this.updateStatus(`Exported ${filename}`);
            } catch (error) {
                console.error('FMAP export failed:', error);
                this.updateStatus('Unable to export .fmap file.', true);
            }
        }

        initializeDownloadControls() {
            const today = this.getUtcDateString(0);
            const sevenDaysAgo = this.getUtcDateString(-7);
            const dateStr = this.getDefaultGfsDate();
            if (this.ui.gfsDateInput) {
                this.ui.gfsDateInput.value = dateStr;
                this.ui.gfsDateInput.max = today;
                this.ui.gfsDateInput.min = sevenDaysAgo;
                this.ui.gfsDateInput.disabled = false;
            }
            const cycle = this.getSuggestedCycle();
            if (this.ui.gfsCycleInput) {
                this.ui.gfsCycleInput.value = cycle;
                this.ui.gfsCycleInput.disabled = false;
            }
            if (this.ui.gfsHourInput) {
                this.ui.gfsHourInput.value = '0';
                this.ui.gfsHourInput.disabled = false;
            }
            if (this.ui.downloadButton) {
                this.ui.downloadButton.disabled = false;
            }
            this.setDownloadBusy(false);
        }

        getUtcDateString(offsetDays = 0) {
            const date = new Date();
            if (offsetDays !== 0) {
                date.setUTCDate(date.getUTCDate() + offsetDays);
            }
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, '0');
            const day = String(date.getUTCDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        getDefaultGfsDate() {
            return this.getUtcDateString(0);
        }

        getSuggestedCycle() {
            const hour = new Date().getUTCHours();
            if (hour >= 18) return '18';
            if (hour >= 12) return '12';
            if (hour >= 6) return '06';
            return '00';
        }

        setDownloadBusy(isBusy) {
            this.downloadInProgress = isBusy;
            if (this.ui.downloadButton) {
                this.ui.downloadButton.disabled = isBusy;
                this.ui.downloadButton.classList.toggle('is-busy', isBusy);
            }
        }

        clampGfsDate(dateStr) {
            const fallback = this.getDefaultGfsDate();
            if (!dateStr) return fallback;
            const parsed = this.parseIsoDate(dateStr) || this.parseIsoDate(fallback);
            const maxDate = this.parseIsoDate(this.getUtcDateString(0));
            const minDate = this.parseIsoDate(this.getUtcDateString(-7));
            if (!parsed || !maxDate || !minDate) return fallback;
            if (parsed > maxDate) return this.getUtcDateString(0);
            if (parsed < minDate) return this.getUtcDateString(-7);
            return this.formatIsoDate(parsed);
        }

        parseIsoDate(dateStr) {
            if (!dateStr) return null;
            const parts = dateStr.split('-');
            if (parts.length !== 3) return null;
            const [yearStr, monthStr, dayStr] = parts;
            const year = Number(yearStr);
            const month = Number(monthStr);
            const day = Number(dayStr);
            if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
            const date = new Date(Date.UTC(year, month - 1, day));
            if (Number.isNaN(date.getTime())) return null;
            return date;
        }

        formatIsoDate(date) {
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, '0');
            const day = String(date.getUTCDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        async handleDownloadWeather() {
            if (this.downloadInProgress) return;
            if (typeof window.fetchGfsFmap !== 'function') {
                this.updateStatus('GFS downloader unavailable.', true);
                return;
            }
            const bounds = window.getCurrentTheaterBounds?.();
            if (!bounds) {
                this.updateStatus('No theater bounds available.', true);
                return;
            }
            const rawDate = this.ui.gfsDateInput?.value || this.getDefaultGfsDate();
            const clampedDate = this.clampGfsDate(rawDate);
            if (this.ui.gfsDateInput) {
                this.ui.gfsDateInput.value = clampedDate;
            }
            const cycle = this.ui.gfsCycleInput?.value || this.getSuggestedCycle();
            const forecastHour = Number(this.ui.gfsHourInput?.value || 0);

            try {
                this.setDownloadBusy(true);
                this.updateStatus('Fetching NOAA GFS data…');
                const product = await window.fetchGfsFmap({
                    date: clampedDate.replace(/-/g, ''),
                    cycle,
                    forecastHour,
                    bounds
                });
                if (!product?.fmap) {
                    throw new Error('Incomplete GFS response');
                }
                const buffer = this.createFmapBuffer(product);
                if (!buffer) {
                    throw new Error('Unable to convert GFS data');
                }
                this.loadFromArrayBuffer(buffer, product.filename || 'gfs-weather.fmap');
            } catch (error) {
                console.error('GFS download failed:', error);
                const message = error?.message ? `Failed to download weather: ${error.message}` : 'Failed to download weather.';
                this.updateStatus(message, true);
            } finally {
                this.setDownloadBusy(false);
            }
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
                        weatherClass: cell.weatherClass,
                        hasRain: cell.hasRain
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

        createTemperatureStyle(feature, resolution) {
            if (!this.data || resolution > 30) return null;

            const temp = feature.get('temperature');
            if (!Number.isFinite(temp)) return null;

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

        createWeatherTypeStyle(feature, resolution) {
            const weatherClass = feature.get('weatherClass');
            const colors = {
                2: 'rgba(34,197,94,0.5)',
                3: 'rgba(250,204,21,0.5)',
                4: 'rgba(239,68,68,0.5)'
            };
            const fillColor = colors[weatherClass];
            if (!fillColor) return null;

            const styles = [
                new ol.style.Style({
                    fill: new ol.style.Fill({ color: fillColor })
                })
            ];

            if (feature.get('hasRain')) {
                const radius = clamp(8 - (resolution * 0.12), 3, 6);
                styles.push(new ol.style.Style({
                    geometry: (feat) => feat.getGeometry()?.getInteriorPoint(),
                    image: new ol.style.RegularShape({
                        points: 3,
                        radius,
                        rotation: Math.PI,
                        fill: new ol.style.Fill({ color: 'rgba(59,130,246,0.95)' }),
                        stroke: new ol.style.Stroke({ color: 'rgba(15,23,42,0.95)', width: 1 })
                    })
                }));
            }

            return styles;
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
            const generalLines = this.buildGeneralDebugLines();
            const cellLines = this.buildCellDebugLines(cell);
            const html = [
                '<div class="weather-debug-section weather-debug-general">',
                '<div class="weather-debug-title">Map Info</div>',
                ...generalLines,
                '</div>',
                '<div class="weather-debug-section weather-debug-cell">',
                `<div class="weather-debug-title">Cell ${cell.col}, ${cell.row}</div>`,
                ...cellLines,
                '</div>'
            ].join('');

            this.debugElement.innerHTML = html;
            this.debugElement.classList.add('is-visible');
            this.debugOverlay.setPosition(coordinate);
        }

        buildGeneralDebugLines() {
            if (!this.data) {
                return ['<div>No weather data</div>'];
            }

            const {
                fmap = {},
                columns,
                rows,
                cellSpacingKm,
                totalCells,
                nodeCount,
                anchor
            } = this.data;

            const analytics = fmap.analytics || {};
            const gridText = Number.isFinite(columns) && Number.isFinite(rows)
                ? `${columns} x ${rows}`
                : 'N/A';
            const spacingText = Number.isFinite(cellSpacingKm)
                ? `${cellSpacingKm.toFixed(1)} km`
                : 'N/A';
            const totalCellsText = Number.isFinite(totalCells ?? fmap.cells)
                ? (totalCells ?? fmap.cells)
                : 'N/A';
            const anchorText = Array.isArray(anchor) && anchor.length
                ? anchor.join(', ')
                : 'N/A';
            const timeText = fmap.time || this.extractTimeFromFilename(this.filename) || 'N/A';
            const versionText = fmap.version ?? this.data.version ?? 'N/A';
            const airmassDir = fmap.airmass?.direction;
            const airmassSpeed = fmap.airmass?.speed;
            const airmassText = Number.isFinite(airmassDir) && Number.isFinite(airmassSpeed)
                ? `${Math.round(airmassDir)}&deg; / ${Math.round(airmassSpeed)} kt`
                : 'N/A';
            const turbTop = fmap.turbulence?.top;
            const turbBottom = fmap.turbulence?.bottom;
            const turbulenceText = (Number.isFinite(turbTop) || Number.isFinite(turbBottom))
                ? `${this.formatFeet(turbTop)} - ${this.formatFeet(turbBottom)}`
                : 'N/A';
            const contrailValues = Array.isArray(fmap.contrail)
                ? fmap.contrail.filter(value => Number.isFinite(value))
                : [];
            const contrailText = contrailValues.length
                ? contrailValues.map(value => this.formatFeet(value)).join(', ')
                : 'N/A';

            return [
                `<div><strong>File</strong>${this.filename || 'N/A'}</div>`,
                `<div><strong>Time</strong>${timeText}</div>`,
                `<div><strong>Version</strong>${versionText}</div>`,
                `<div><strong>Grid</strong>${gridText}</div>`,
                `<div><strong>Cells</strong>${totalCellsText} (nodes ${nodeCount ?? 'N/A'})</div>`,
                `<div><strong>Cell Spacing</strong>${spacingText}</div>`,
                `<div><strong>Anchor</strong>${anchorText}</div>`,
                `<div><strong>Airmass</strong>${airmassText}</div>`,
                `<div><strong>Turbulence</strong>${turbulenceText}</div>`,
                `<div><strong>Contrail</strong>${contrailText}</div>`,
                `<div><strong>Pressure Range</strong>${this.formatRange(analytics.pressure_min, analytics.pressure_max, 'hPa', 0)}</div>`,
                `<div><strong>Temp Range</strong>${this.formatRange(analytics.temperature_min, analytics.temperature_max, '&deg;C', 1)}</div>`
            ];
        }

        buildCellDebugLines(cell) {
            const lines = [];
            const weatherClass = WEATHER_CLASSES[cell.weatherClass];
            lines.push(`<div><strong>Weather</strong>${weatherClass?.label || (cell.weatherClass ? `Class ${cell.weatherClass}` : 'N/A')}</div>`);
            lines.push(`<div><strong>Temp</strong>${Number.isFinite(cell.temperatureC) ? `${cell.temperatureC.toFixed(1)} &deg;C` : 'N/A'}</div>`);
            lines.push(`<div><strong>Pressure</strong>${Number.isFinite(cell.pressureMb) ? `${cell.pressureMb.toFixed(0)} hPa` : 'N/A'}</div>`);

            const altitudeFt = WIND_ALTITUDES_FT[this.windAltitudeIndex] || 0;
            const altitudeLabel = altitudeFt >= 1000 ? `${(altitudeFt / 1000).toFixed(0)}kft` : `${altitudeFt}ft`;
            const windSpeed = cell.windSpeed?.[this.windAltitudeIndex];
            const windDir = cell.windDirection?.[this.windAltitudeIndex];
            const windText = Number.isFinite(windDir) && Number.isFinite(windSpeed)
                ? `${windDir.toFixed(0)}&deg; / ${windSpeed.toFixed(0)} kt`
                : 'N/A';
            lines.push(`<div><strong>Wind ${altitudeLabel}</strong>${windText}</div>`);

            lines.push(`<div><strong>Cloud Cover</strong>${cell.cloudCoverageIndex ?? 'N/A'}</div>`);
            lines.push(`<div><strong>Cloud Base</strong>${this.formatFeet(cell.cloudBaseFt)}</div>`);
            if (Number.isFinite(cell.cloudDepthFt)) {
                lines.push(`<div><strong>Cloud Depth</strong>${this.formatFeet(cell.cloudDepthFt)}</div>`);
            }
            lines.push(`<div><strong>Cloud Type</strong>${CLOUD_TYPES[cell.cloudTypeIndex] || 'N/A'}</div>`);
            lines.push(`<div><strong>Visibility</strong>${this.formatKm(cell.visibilityKm)}</div>`);
            lines.push(`<div><strong>Fog Base</strong>${this.formatFeet(cell.fogBaseFt)}</div>`);
            lines.push(`<div><strong>Rain</strong>${cell.hasRain ? 'Yes' : 'No'}</div>`);
            lines.push(`<div><strong>Storm</strong>${cell.hasStorm ? 'Yes' : 'No'}</div>`);

            return lines;
        }

        formatFeet(value) {
            if (!Number.isFinite(value)) return 'N/A';
            if (Math.abs(value) >= 1000) {
                return `${(value / 1000).toFixed(1)} kft`;
            }
            return `${Math.round(value)} ft`;
        }

        formatKm(value) {
            return Number.isFinite(value) ? `${value.toFixed(1)} km` : 'N/A';
        }

        formatRange(min, max, unit = '', digits = 1) {
            if (!Number.isFinite(min) && !Number.isFinite(max)) {
                return 'N/A';
            }
            const suffix = unit ? ` ${unit}` : '';
            const minStr = Number.isFinite(min) ? `${min.toFixed(digits)}${suffix}` : 'N/A';
            const maxStr = Number.isFinite(max) ? `${max.toFixed(digits)}${suffix}` : 'N/A';
            return `${minStr} - ${maxStr}`;
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

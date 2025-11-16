(function () {
    const GFS_DEBUG = false;

    const GFS_ENDPOINT = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?';
    const GFS_PROXY = 'https://corsproxy.io/?';
    const GFS_LEVELS = '&lev_100_mb=on&lev_150_mb=on&lev_200_mb=on&lev_300_mb=on&lev_400_mb=on&lev_500_mb=on&lev_650_mb=on&lev_700_mb=on&lev_850_mb=on&lev_925_mb=on&lev_2_m_above_ground=on&lev_10_m_above_ground=on&lev_convective_cloud_layer=on&lev_high_cloud_layer=on&lev_low_cloud_layer=on&lev_mean_sea_level=on&lev_middle_cloud_layer=on&lev_surface=on&lev_convective_cloud_bottom_level=on&lev_convective_cloud_top_level=on&lev_high_cloud_bottom_level=on&lev_high_cloud_top_level=on&lev_low_cloud_bottom_level=on&lev_low_cloud_top_level=on&lev_middle_cloud_bottom_level=on&lev_middle_cloud_top_level=on';
    const GFS_PARAMS = '&var_ACPCP=on&var_APCP=on&var_PRATE=on&var_PRMSL=on&var_TCDC=on&var_TMP=on&var_UGRD=on&var_VGRD=on&var_VIS=on&var_PRES=on&var_HGT=on';
    const GFS_SAVE_RAW_GRIB = false; // set true for debug to capture raw GRIB payloads
    const CLOUD_TYPE_THRESHOLDS = [2, 4, 6];
    const CLOUD_MIN_DEPTH_FT = 500;
    const CLOUD_BOTTOM_TYPES = new Set([212, 222, 232, 242]);
    const CLOUD_TOP_TYPES = new Set([213, 223, 233, 243]);

    const MSG_TYPES = {
        TMP: 0,
        PRATE: 263,
        APCP: 264,
        ACPCP: 266,
        UGRD: 514,
        VGRD: 515,
        PRES: 768,
        HGT: 773,
        PRMSL: 769,
        TCDC: 1537,
        VIS: 4864,
        UNKN: -1
    };

    const PRESSURE_LUT = [
        1013, 977, 942, 908, 875, 843, 812, 782, 753, 724, 697,
        670, 644, 619, 595, 572, 549, 527, 506, 485, 466
    ];

    const TEMPERATURE_LUT = [
        15.0, 13.0, 11.0, 9.1, 7.1, 5.1, 3.1, 1.1, -0.8, -2.8, -4.8,
        -6.8, -8.8, -10.8, -12.7, -14.7, -16.7, -18.7, -20.7, -22.6, -24.6
    ];

    const PRESSURE_ALT_LEVELS = [10, 92500, 85000, 70000, 65000, 50000, 40000, 30000, 20000, 10000];

    const DEFAULT_BOUNDS = { top: 90, left: 0, right: 360, bottom: -90 };
    const TARGET_FMAP_VERSION = 8;

    let fmap = null;
    let gfsFile = null;
    let gfsMsg = null;
    let gfsFields = null;

    function gfsDebug(...args) {
        if (GFS_DEBUG) {
            console.log(...args);
        }
    }

    function pad(value, digits = 2) {
        return value.toString().padStart(digits, '0');
    }

    function normalizeDateString(dateStr) {
        if (!dateStr) {
            const now = new Date();
            return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
        }
        return dateStr.replace(/-/g, '');
    }

    function normalizeCycle(cycle) {
        const allowed = ['00', '06', '12', '18'];
        if (allowed.includes(cycle)) return cycle;
        const now = new Date();
        const hour = now.getUTCHours();
        if (hour >= 18) return '18';
        if (hour >= 12) return '12';
        if (hour >= 6) return '06';
        return '00';
    }

    function normalizeForecastHour(hour) {
        const value = Number.isFinite(hour) ? Math.max(0, Math.min(384, Math.trunc(hour))) : 0;
        return value;
    }

    function getFilename(cycle, forecastHour) {
        const forecast = pad(forecastHour, 3);
        return `gfs.t${cycle}z.pgrb2.0p25.f${forecast}`;
    }

    function getDirname(date, cycle) {
        return `/gfs.${date}/${cycle}/atmos`;
    }

    function getSubregion(bounds) {
        const region = bounds || DEFAULT_BOUNDS;
        return `&subregion=&toplat=${region.top}&leftlon=${region.left}&rightlon=${region.right}&bottomlat=${region.bottom}`;
    }

    function constructUrl(date, cycle, forecastHour, bounds) {
        const file = getFilename(cycle, forecastHour);
        const dir = encodeURIComponent(getDirname(date, cycle));
        const subregion = getSubregion(bounds);
        const filter = `dir=${dir}&file=${file}${GFS_PARAMS}${GFS_LEVELS}${subregion}`;
        return `${GFS_ENDPOINT}${filter}`;
    }

    function buildForecastBasename(date, cycle, forecastHour) {
        const safeDate = date || '00000000';
        const safeCycle = cycle || '00';
        const hour = pad(forecastHour, 3);
        return `gfs-${safeDate}-${safeCycle}z-f${hour}`;
    }

    function resolveLevelValue(field) {
        if (!field) return null;
        const rawValue = Number(field.level);
        if (!Number.isFinite(rawValue)) return null;
        const factor = Number.isFinite(field.levelFactor) ? field.levelFactor : 0;
        const scale = 10 ** (-factor);
        return rawValue * scale;
    }

    function altitudeFromLevel(field, y, x) {
        if (!field) return null;
        const levelType = field.levelType;
        const levelValue = resolveLevelValue(field);
        if (!Number.isFinite(levelType) || !Number.isFinite(levelValue)) return null;
        if (levelType === 100) {
            const prmslRow = fmap.pressure[y];
            const tempRow = fmap.temperature[y];
            if (!prmslRow) return null;
            const prmsl = prmslRow[x];
            const surfTemp = tempRow ? tempRow[x] : 15;
            if (!Number.isFinite(prmsl) || prmsl <= 0) return null;
            const tempValue = Number.isFinite(surfTemp) ? surfTemp : 15;
            return altFromPres(prmsl * 100, levelValue, tempValue);
        }
        if (levelType === 103 || levelType === 104) {
            return levelValue * 3.28084;
        }
        return null;
    }

    function classifyCloudType(coverage) {
        if (!Number.isFinite(coverage)) return 0;
        if (coverage > CLOUD_TYPE_THRESHOLDS[2]) return 4;
        if (coverage > CLOUD_TYPE_THRESHOLDS[1]) return 3;
        if (coverage > CLOUD_TYPE_THRESHOLDS[0]) return 2;
        return coverage > 0 ? 1 : 0;
    }

    function updateCloudThickness(y, x) {
        const base = fmap.cloud.base[y][x];
        const top = fmap.cloud.top[y][x];
        if (Number.isFinite(base) && base > 0 && Number.isFinite(top) && top > base) {
            const depthFt = Math.max(CLOUD_MIN_DEPTH_FT, top - base);
            fmap.cloud.size[y][x] = depthFt / 1000;
        } else {
            fmap.cloud.size[y][x] = 0;
        }
    }

    async function saveRawGribPayload(buffer, filename) {
        if (!GFS_SAVE_RAW_GRIB) return;
        if (typeof window === 'undefined') return;
        try {
            const blob = new Blob([buffer], { type: 'application/octet-stream' });
            if (typeof window.showSaveFilePicker === 'function') {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'GRIB2 files',
                        accept: { 'application/octet-stream': ['.grib2', '.grb2', '.grb'] }
                    }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return;
            }
            if (typeof document === 'undefined') return;
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.warn('Unable to save raw GFS payload', error);
        }
    }

    async function fetchWithFallback(url) {
        const targets = [url];
        if (GFS_PROXY) {
            targets.push(`${GFS_PROXY}${encodeURIComponent(url)}`);
        }
        let lastError = null;
        for (const target of targets) {
            try {
                const response = await fetch(target, { mode: 'cors' });
                if (response.ok) {
                    return response;
                }
                lastError = new Error(`GFS request failed (${response.status})`);
                lastError.status = response.status;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('Unable to fetch GFS data');
    }

    function shiftDateString(dateStr, deltaDays) {
        if (!dateStr || dateStr.length !== 8) return dateStr;
        const year = Number(dateStr.slice(0, 4));
        const month = Number(dateStr.slice(4, 6)) - 1;
        const day = Number(dateStr.slice(6, 8));
        const date = new Date(Date.UTC(year, month, day));
        date.setUTCDate(date.getUTCDate() + deltaDays);
        const newYear = date.getUTCFullYear();
        const newMonth = pad(date.getUTCMonth() + 1);
        const newDay = pad(date.getUTCDate());
        return `${newYear}${newMonth}${newDay}`;
    }

    function buildRequestVariants(dateStr, cycle, maxDaysBack = 2) {
        const variants = [];
        const cycles = ['00', '06', '12', '18'];
        const normalizedCycle = cycles.includes(cycle) ? cycle : '00';
        let idx = cycles.indexOf(normalizedCycle);
        let currentDate = dateStr;
        for (let dayOffset = 0; dayOffset <= maxDaysBack; dayOffset += 1) {
            const targetDate = currentDate;
            for (let c = idx; c >= 0; c -= 1) {
                variants.push({ date: targetDate, cycle: cycles[c] });
            }
            idx = cycles.length - 1;
            currentDate = shiftDateString(currentDate, -1);
        }
        return variants;
    }

    function swapBytes(bytes, s, d) {
        const tmp = bytes[s];
        bytes[s] = bytes[d];
        bytes[d] = tmp;
    }

    function adjustEndianness(bytes) {
        const test = new Uint32Array([0x11223344]);
        const view = new Uint8Array(test.buffer);
        if (view[0] === 0x11) return bytes;
        const len = bytes.length;
        switch (len) {
            case 2:
                swapBytes(bytes, 0, 1);
                break;
            case 4:
                swapBytes(bytes, 0, 3);
                swapBytes(bytes, 1, 2);
                break;
            case 8:
                swapBytes(bytes, 0, 7);
                swapBytes(bytes, 1, 6);
                swapBytes(bytes, 2, 5);
                swapBytes(bytes, 3, 4);
                break;
            default:
                break;
        }
        return bytes;
    }

    function arrayToString(bytes) {
        return String.fromCharCode(...bytes);
    }

    function arrayToInt(bytes) {
        let value = 0;
        for (let i = bytes.length - 1; i >= 0; i -= 1) {
            value = (value * 256) + bytes[i];
        }
        return value;
    }

    function bitUnpack(array, bitSize, index) {
        const mask = (1 << bitSize) - 1;
        const startBit = index * bitSize;
        const endBit = startBit + bitSize;
        const shift = 8 - (endBit % 8);
        const startByte = (startBit / 8) >> 0;
        const endByte = (endBit / 8) >> 0;

        let result = 0;
        for (let i = startByte; i <= endByte; i += 1) {
            result = (result * 256) + array[i];
        }
        result = (result >> shift) & mask;
        return result;
    }

    function sectionOctet(start, end) {
        return gfsFile.bytes.slice(gfsFile.offset + start - 1, gfsFile.offset + end);
    }

    function sectionInt(start, end) {
        return arrayToInt(adjustEndianness(sectionOctet(start, end)));
    }

    function sectionFloat32(start, end) {
        const buf = new Uint8Array(sectionOctet(start, end)).buffer;
        const value = new DataView(buf);
        return value.getFloat32(0);
    }

    function readSection0() {
        gfsMsg.s0.offset = gfsFile.offset;
        gfsMsg.s0.grib = arrayToString(sectionOctet(1, 4));
        if (gfsMsg.s0.grib === 'GRIB') {
            gfsMsg.s0.discipline = sectionInt(7, 7);
            gfsMsg.s0.edition = sectionInt(8, 8);
            gfsMsg.s0.size = sectionInt(9, 16);
            gfsFile.offset += 16;
            gfsDebug(gfsMsg.s0);
        }
    }

    function readSection1() {
        gfsMsg.s1.section = arrayToInt(sectionOctet(5, 5));
        if (gfsMsg.s1.section === 1) {
            gfsMsg.s1.offset = gfsFile.offset;
            gfsMsg.s1.size = sectionInt(1, 4);
            gfsMsg.s1.center = sectionInt(6, 7);
            gfsMsg.s1.subcenter = sectionInt(8, 9);
            gfsMsg.s1.mastr_tbl_ver = sectionInt(10, 10);
            gfsMsg.s1.local_tbl_ver = sectionInt(11, 11);
            gfsMsg.s1.time_ref = sectionInt(12, 12);
            gfsMsg.s1.year = sectionInt(13, 14);
            gfsMsg.s1.month = sectionInt(15, 15);
            gfsMsg.s1.day = sectionInt(16, 16);
            gfsMsg.s1.hour = sectionInt(17, 17);
            gfsMsg.s1.minute = sectionInt(18, 18);
            gfsMsg.s1.second = sectionInt(19, 19);
            gfsMsg.s1.status = sectionInt(20, 20);
            gfsMsg.s1.type = sectionInt(21, 21);
            gfsFile.offset += gfsMsg.s1.size;
            gfsDebug(gfsMsg.s1);
        }
    }

    function readSection2() {
        gfsMsg.s2.section = sectionInt(5, 5);
        if (gfsMsg.s2.section === 2) {
            gfsMsg.s2.offset = gfsFile.offset;
            gfsMsg.s2.size = sectionInt(1, 4);
            gfsFile.offset += gfsMsg.s2.size;
            gfsDebug(gfsMsg.s2);
        }
    }

    function gridTemplate3_0() {
        gfsMsg.s3.def.name = 'Latitude/Longitude';
        gfsMsg.s3.def.earth_shape = sectionInt(15, 15);
        gfsMsg.s3.def.scale_factor_radius = sectionInt(16, 16);
        gfsMsg.s3.def.scaled_value_radius = sectionInt(17, 20);
        gfsMsg.s3.def.scale_factor_majorx = sectionInt(21, 21);
        gfsMsg.s3.def.scaled_value_majorx = sectionInt(22, 25);
        gfsMsg.s3.def.scale_factor_minorx = sectionInt(26, 26);
        gfsMsg.s3.def.scaled_value_minorx = sectionInt(27, 30);
        gfsMsg.s3.def.Ni = sectionInt(31, 34);
        gfsMsg.s3.def.Nj = sectionInt(35, 38);
        gfsMsg.s3.def.basic_angle = sectionInt(39, 42);
        gfsMsg.s3.def.basic_angle_subdiv = sectionInt(43, 46);
        gfsMsg.s3.def.lat1 = sectionInt(47, 50);
        gfsMsg.s3.def.long1 = sectionInt(51, 54);
        gfsMsg.s3.def.res_flags = sectionInt(55, 55);
        gfsMsg.s3.def.lat2 = sectionInt(56, 59);
        gfsMsg.s3.def.long2 = sectionInt(60, 63);
        gfsMsg.s3.def.Di = sectionInt(64, 67);
        gfsMsg.s3.def.Dj = sectionInt(68, 71);
        gfsMsg.s3.def.scan_flags = sectionInt(72, 72);
    }

    function readSection3() {
        gfsMsg.s3.section = sectionInt(5, 5);
        if (gfsMsg.s3.section === 3) {
            gfsMsg.s3.size = sectionInt(1, 4);
            gfsMsg.s3.grid_source = sectionInt(6, 6);
            gfsMsg.s3.num_points = sectionInt(7, 10);
            gfsMsg.s3.num_octets = sectionInt(11, 11);
            gfsMsg.s3.list_num = sectionInt(12, 12);
            gfsMsg.s3.template = sectionInt(13, 14);
            if (gfsMsg.s3.template === 0) {
                gridTemplate3_0();
            } else {
                gfsDebug('Unhandled grid template', gfsMsg.s3.template);
            }
            gfsFile.offset += gfsMsg.s3.size;
            gfsDebug(gfsMsg.s3);
        }
    }

    function prodTemplate4_0() {
        gfsMsg.s4.def.name = 'Analysis or forecast at a horizontal level';
        gfsMsg.s4.def.param_cat = sectionInt(10, 10);
        gfsMsg.s4.def.param_num = sectionInt(11, 11);
        gfsMsg.s4.def.process_type = sectionInt(12, 12);
        gfsMsg.s4.def.process_bgnd = sectionInt(13, 13);
        gfsMsg.s4.def.process_model = sectionInt(14, 14);
        gfsMsg.s4.def.data_hrs = sectionInt(15, 16);
        gfsMsg.s4.def.data_min = sectionInt(17, 17);
        gfsMsg.s4.def.time_unit = sectionInt(18, 18);
        gfsMsg.s4.def.time_forecast = sectionInt(19, 22);
        gfsMsg.s4.def.surface1_type = sectionInt(23, 23);
        gfsMsg.s4.def.surface1_factor = sectionInt(24, 24);
        gfsMsg.s4.def.surface1_value = sectionInt(25, 28);
        gfsMsg.s4.def.surface2_type = sectionInt(29, 29);
        gfsMsg.s4.def.surface2_factor = sectionInt(30, 30);
        gfsMsg.s4.def.surface2_value = sectionInt(31, 34);
    }

    function prodTemplate4_8() {
        gfsMsg.s4.def.name = 'Avg/Accumulation values';
        gfsMsg.s4.def.param_cat = sectionInt(10, 10);
        gfsMsg.s4.def.param_num = sectionInt(11, 11);
        gfsMsg.s4.def.process_type = sectionInt(12, 12);
        gfsMsg.s4.def.process_bgnd = sectionInt(13, 13);
        gfsMsg.s4.def.process_model = sectionInt(14, 14);
        gfsMsg.s4.def.data_hrs = sectionInt(15, 16);
        gfsMsg.s4.def.data_min = sectionInt(17, 17);
        gfsMsg.s4.def.time_unit = sectionInt(18, 18);
        gfsMsg.s4.def.time_forecast = sectionInt(19, 22);
        gfsMsg.s4.def.surface1_type = sectionInt(23, 23);
        gfsMsg.s4.def.surface1_factor = sectionInt(24, 24);
        gfsMsg.s4.def.surface1_value = sectionInt(25, 28);
        gfsMsg.s4.def.surface2_type = sectionInt(29, 29);
        gfsMsg.s4.def.surface2_factor = sectionInt(30, 30);
        gfsMsg.s4.def.surface2_value = sectionInt(31, 34);
        gfsMsg.s4.def.end_year = sectionInt(35, 36);
        gfsMsg.s4.def.end_month = sectionInt(37, 37);
        gfsMsg.s4.def.end_day = sectionInt(38, 38);
        gfsMsg.s4.def.end_hour = sectionInt(39, 39);
        gfsMsg.s4.def.end_minute = sectionInt(40, 40);
        gfsMsg.s4.def.end_second = sectionInt(41, 41);
        gfsMsg.s4.def.num_intervals = sectionInt(42, 42);
        gfsMsg.s4.def.num_missing_data = sectionInt(43, 46);
    }

    function readSection4() {
        gfsMsg.s4.section = sectionInt(5, 5);
        if (gfsMsg.s4.section === 4) {
            gfsMsg.s4.offset = gfsFile.offset;
            gfsMsg.s4.size = sectionInt(1, 4);
            gfsMsg.s4.num_coords = sectionInt(6, 7);
            gfsMsg.s4.template = sectionInt(8, 9);
            gfsMsg.s4.def = {};
            if (gfsMsg.s4.template === 0) {
                prodTemplate4_0();
            } else if (gfsMsg.s4.template === 8) {
                prodTemplate4_8();
            } else {
                gfsDebug('Missing product template', gfsMsg.s4.template);
            }
            gfsFile.offset += gfsMsg.s4.size;
            gfsDebug(gfsMsg.s4);
        }
    }

    function dataTemplate5_0() {
        gfsMsg.s5.def.name = 'Grid point data - simple packing';
        gfsMsg.s5.def.ref_value = sectionFloat32(12, 15);
        gfsMsg.s5.def.bin_scale = sectionInt(16, 17);
        gfsMsg.s5.def.dec_scale = sectionInt(18, 19);
        gfsMsg.s5.def.bits = sectionInt(20, 20);
        gfsMsg.s5.def.type = sectionInt(21, 21);
    }

    function readSection5() {
        gfsMsg.s5.section = sectionInt(5, 5);
        if (gfsMsg.s5.section === 5) {
            gfsMsg.s5.offset = gfsFile.offset;
            gfsMsg.s5.size = sectionInt(1, 4);
            gfsMsg.s5.num_points = sectionInt(6, 9);
            gfsMsg.s5.template = sectionInt(10, 11);
            gfsMsg.s5.def = {};
            if (gfsMsg.s5.template === 0) {
                dataTemplate5_0();
            } else {
                gfsDebug('Missing data template', gfsMsg.s5.template);
            }
            gfsFile.offset += gfsMsg.s5.size;
            gfsDebug(gfsMsg.s5);
        }
    }

    function readSection6() {
        gfsMsg.s6.section = sectionInt(5, 5);
        if (gfsMsg.s6.section === 6) {
            gfsMsg.s6.offset = gfsFile.offset;
            gfsMsg.s6.size = sectionInt(1, 4);
            gfsMsg.s6.indicator = sectionInt(6, 6);
            if (gfsMsg.s6.indicator === 0) {
                gfsMsg.s6.bitmap = sectionOctet(7, gfsMsg.s6.size);
            }
            gfsFile.offset += gfsMsg.s6.size;
            gfsDebug(gfsMsg.s6);
        }
    }

    function readSection7() {
        gfsMsg.s7.section = sectionInt(5, 5);
        if (gfsMsg.s7.section === 7) {
            gfsMsg.s7.offset = gfsFile.offset;
            gfsMsg.s7.size = sectionInt(1, 4);
            gfsMsg.s7.data = sectionOctet(6, gfsMsg.s7.size);
            gfsFile.offset += gfsMsg.s7.size;
            gfsDebug(gfsMsg.s7);
        }
    }

    function readSection8() {
        gfsMsg.s8.tag = arrayToString(sectionOctet(1, 4));
        if (gfsMsg.s8.tag === '7777') {
            gfsMsg.s8.size = 4;
            gfsFile.offset += gfsMsg.s8.size;
            gfsDebug(gfsMsg.s8);
        }
    }

    function readMessage() {
        readSection0();
        readSection1();
        readSection2();
        readSection3();
        readSection4();
        readSection5();
        readSection6();
        readSection7();
        readSection8();
    }

    function decodeSimplePacking(index) {
        const value = bitUnpack(gfsMsg.s7.data, gfsMsg.s5.def.bits, index);
        const binScale = (1 << gfsMsg.s5.def.bin_scale);
        const decScale = 10 ** gfsMsg.s5.def.dec_scale;
        const res = (gfsMsg.s5.def.ref_value + value * binScale) / decScale;
        return res;
    }

    function upscaleData(data) {
        for (let y = 0; y < fmap.dimension.y - 1; y += 1) {
            for (let x = 0; x < fmap.dimension.x - 1; x += 1) {
                if (x > 0 && x % 2 > 0) {
                    data[y][x] = (data[y][x - 1] + data[y][x + 1]) / 2;
                }
                if (y > 0 && y % 2 > 0) {
                    data[y][x] = (data[y - 1][x] + data[y + 1][x]) / 2;
                }
            }
        }
    }

    function decodeMsg(name, bufferField) {
        bufferField.name = name;
        bufferField.level = gfsMsg.s4.def.surface1_value;
        bufferField.levelFactor = gfsMsg.s4.def.surface1_factor;
        bufferField.levelType = gfsMsg.s4.def.surface1_type;
        bufferField.data = Array.from({ length: gfsMsg.s3.num_points }, (_, i) => decodeSimplePacking(i));
    }

    function transcodeMsg(name, src, dest) {
        if (src.name !== name) return;
        if (!Array.isArray(dest) || dest.length !== fmap.dimension.y) {
            dest.length = fmap.dimension.y;
            for (let y = 0; y < fmap.dimension.y; y += 1) {
                dest[y] = new Array(fmap.dimension.x).fill(0);
            }
        }
        const scaleY = gfsMsg.s3.def.Nj / fmap.dimension.y;
        const scaleX = gfsMsg.s3.def.Ni / fmap.dimension.x;

        for (let y = 0; y < fmap.dimension.y; y += 1) {
            const row = dest[y] || (dest[y] = new Array(fmap.dimension.x).fill(0));
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const gy = ((fmap.dimension.y - 1 - y) * scaleY) >> 0;
                const gx = (x * scaleX) >> 0;
                const idx = gy * gfsMsg.s3.def.Ni + gx;
                const value = src.data[idx] * (src.scale || 1) + (src.offset || 0);
                row[x] = value;
                if (dest === fmap.pressure) {
                    if (value < fmap.analytics.pressure_min) fmap.analytics.pressure_min = value;
                    if (value > fmap.analytics.pressure_max) fmap.analytics.pressure_max = value;
                }
                if (dest === fmap.temperature) {
                    if (value < fmap.analytics.temperature_min) fmap.analytics.temperature_min = value;
                    if (value > fmap.analytics.temperature_max) fmap.analytics.temperature_max = value;
                }
            }
        }
        if (dest === fmap.pressure || dest === fmap.temperature) {
            upscaleData(dest);
        }
    }

    function presToTemp(pressure) {
        let temp = -26.0;
        for (let i = 0; i < PRESSURE_LUT.length; i += 1) {
            if (pressure >= PRESSURE_LUT[i]) {
                temp = TEMPERATURE_LUT[i];
                break;
            }
        }
        return temp;
    }

    function getPressureAltIndex(mb) {
        for (let i = 0; i < PRESSURE_ALT_LEVELS.length; i += 1) {
            if (mb === PRESSURE_ALT_LEVELS[i]) return i;
        }
        return -1;
    }

    function transcodeWinds() {
        const alt = getPressureAltIndex(gfsMsg.s4.def.surface1_value);
        if (alt === -1) return;
        if (gfsFields.ugrd.level !== gfsFields.vgrd.level) return;

        const scaleY = gfsMsg.s3.def.Nj / fmap.dimension.y;
        const scaleX = gfsMsg.s3.def.Ni / fmap.dimension.x;

        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const gy = ((fmap.dimension.y - 1 - y) * scaleY) >> 0;
                const gx = (x * scaleX) >> 0;
                const idx = gy * gfsMsg.s3.def.Ni + gx;
                const ugrd = gfsFields.ugrd.data[idx] * gfsFields.ugrd.scale;
                const vgrd = gfsFields.vgrd.data[idx] * gfsFields.vgrd.scale;
                const direction = 57.29578 * (Math.atan2(ugrd, vgrd)) + 180;
                const speed = Math.sqrt((ugrd * ugrd) + (vgrd * vgrd));
                fmap.wind[y][x][alt] = { direction, speed };
            }
        }
    }

    function transcodeCloudCoverage() {
        const scaleY = gfsMsg.s3.def.Nj / fmap.dimension.y;
        const scaleX = gfsMsg.s3.def.Ni / fmap.dimension.x;

        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const gy = ((fmap.dimension.y - 1 - y) * scaleY) >> 0;
                const gx = (x * scaleX) >> 0;
                const idx = gy * gfsMsg.s3.def.Ni + gx;
                const coverage = Math.round(gfsFields.tcdc.data[idx] * gfsFields.tcdc.scale);
                if (coverage > fmap.cloud.cover[y][x]) {
                    fmap.cloud.cover[y][x] = coverage;
                }
                const cloudType = classifyCloudType(coverage);
                if (cloudType > fmap.cloud.type[y][x]) {
                    fmap.cloud.type[y][x] = cloudType;
                }
                if (coverage > 6 && fmap.cloud.size[y][x] > 1) {
                    fmap.cloud.size[y][x] -= 1;
                }
                if (fmap.cloud.size[y][x] === 1) {
                    fmap.cloud.type[y][x] = 1;
                }
                if (coverage <= CLOUD_TYPE_THRESHOLDS[0]) continue;
                const altitudeFt = altitudeFromLevel(gfsFields.tcdc, y, x);
                if (!Number.isFinite(altitudeFt) || altitudeFt <= 0) continue;
                const currentBase = fmap.cloud.base[y][x];
                if (!Number.isFinite(currentBase) || currentBase <= 0 || altitudeFt < currentBase) {
                    fmap.cloud.base[y][x] = altitudeFt;
                }
                const currentTop = fmap.cloud.top[y][x];
                if (!Number.isFinite(currentTop) || altitudeFt > currentTop) {
                    fmap.cloud.top[y][x] = altitudeFt;
                }
                updateCloudThickness(y, x);
            }
        }
    }

    function transcodeCloudHeights() {
        const levelType = gfsMsg.s4.def.surface1_type;
        const isBottom = CLOUD_BOTTOM_TYPES.has(levelType);
        const isTop = CLOUD_TOP_TYPES.has(levelType);
        if (!isBottom && !isTop) return;
        const scaleY = gfsMsg.s3.def.Nj / fmap.dimension.y;
        const scaleX = gfsMsg.s3.def.Ni / fmap.dimension.x;

        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const gy = ((fmap.dimension.y - 1 - y) * scaleY) >> 0;
                const gx = (x * scaleX) >> 0;
                const idx = gy * gfsMsg.s3.def.Ni + gx;
                const meters = gfsFields.hgt.data[idx] * (gfsFields.hgt.scale || 1) + (gfsFields.hgt.offset || 0);
                if (!Number.isFinite(meters) || meters <= 0) continue;
                const heightFt = meters * 3.28084;
                if (isBottom) {
                    const currentBase = fmap.cloud.base[y][x];
                    if (!Number.isFinite(currentBase) || currentBase <= 0 || heightFt < currentBase) {
                        fmap.cloud.base[y][x] = heightFt;
                    }
                }
                if (isTop) {
                    const currentTop = fmap.cloud.top[y][x];
                    if (!Number.isFinite(currentTop) || heightFt > currentTop) {
                        fmap.cloud.top[y][x] = heightFt;
                    }
                }
                if (isBottom || isTop) {
                    updateCloudThickness(y, x);
                }
            }
        }
    }

    function transcodeShowers() {
        const scaleY = gfsMsg.s3.def.Nj / fmap.dimension.y;
        const scaleX = gfsMsg.s3.def.Ni / fmap.dimension.x;
        const threshold = 1.9;

        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const gy = ((fmap.dimension.y - 1 - y) * scaleY) >> 0;
                const gx = (x * scaleX) >> 0;
                const idx = gy * gfsMsg.s3.def.Ni + gx;
                const prate = gfsFields.prate.data[idx] * gfsFields.prate.scale;
                fmap.shower[y][x] = prate >= threshold ? 1 : 0;
                if (fmap.shower[y][x] === 1 && fmap.cloud.type[y][x] < 1) {
                    fmap.cloud.type[y][x] = 1;
                }
            }
        }
    }

    function altFromPres(prmsl, pres, surfTemp) {
        const R = 8.31432;
        const M = 0.0289644;
        const g = 9.80665;
        const adjustedTemp = presToTemp(pres / 100) + 273.15 + (15 - surfTemp);
        const alt = (Math.log(pres / prmsl) * R * adjustedTemp) / (-g * M);
        return alt * 3.28084;
    }

    function transcodeFogAltitude() {
        if (gfsMsg.s4.def.surface1_type !== 212) return;
        const scaleY = gfsMsg.s3.def.Nj / fmap.dimension.y;
        const scaleX = gfsMsg.s3.def.Ni / fmap.dimension.x;

        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const gy = ((fmap.dimension.y - 1 - y) * scaleY) >> 0;
                const gx = (x * scaleX) >> 0;
                const idx = gy * gfsMsg.s3.def.Ni + gx;
                fmap.fog[y][x] = altFromPres(
                    fmap.pressure[y][x] * 100,
                    gfsFields.pres.data[idx],
                    fmap.temperature[y][x]
                );
            }
        }
    }

    function determineWeatherType() {
        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                const shower = fmap.shower[y][x];
                const cover = fmap.cloud.cover[y][x];
                let type = 1;
                if (cover > 2 && shower === 0) type = 2;
                if (cover > 4 && shower === 0) type = 3;
                if (cover > 4 && shower === 1) type = 4;
                fmap.type[y][x] = type;
            }
        }
    }

    function computeAirmass() {
        const alt = 9;
        let dir = 0;
        let spd = 0;
        for (let y = 0; y < fmap.dimension.y; y += 1) {
            for (let x = 0; x < fmap.dimension.x; x += 1) {
                dir += fmap.wind[y][x][alt].direction;
                spd += fmap.wind[y][x][alt].speed;
            }
        }
        dir /= fmap.cells;
        spd /= fmap.cells;
        fmap.airmass.direction = dir >> 0;
        fmap.airmass.speed = spd / 4;
    }

    function forecastTimestamp() {
        const base = Date.UTC(
            gfsMsg.s1.year,
            (gfsMsg.s1.month || 1) - 1,
            gfsMsg.s1.day || 1,
            gfsMsg.s1.hour || 0,
            gfsMsg.s1.minute || 0,
            gfsMsg.s1.second || 0
        );
        const forecastHours = gfsMsg.s4.def.time_forecast || 0;
        const date = new Date(base + forecastHours * 3600000);
        const year = date.getUTCFullYear();
        const month = pad(date.getUTCMonth() + 1);
        const day = pad(date.getUTCDate());
        const hour = pad(date.getUTCHours());
        const minute = pad(date.getUTCMinutes());
        return `${year}-${month}-${day} ${hour}:${minute}Z`;
    }

    function getMsgType() {
        return gfsMsg.s4.def.param_cat * 256 + gfsMsg.s4.def.param_num;
    }

    function processMessage() {
        switch (getMsgType()) {
            case MSG_TYPES.PRMSL:
                if (gfsMsg.s4.def.surface1_value !== 0) return;
                decodeMsg('PRMSL', gfsFields.prmsl);
                transcodeMsg('PRMSL', gfsFields.prmsl, fmap.pressure);
                gfsFields.prmsl.data = [];
                break;
            case MSG_TYPES.VIS:
                decodeMsg('VIS', gfsFields.vis);
                transcodeMsg('VIS', gfsFields.vis, fmap.visibility);
                gfsFields.vis.data = [];
                break;
            case MSG_TYPES.TMP:
                if (gfsMsg.s4.def.surface1_value !== 2) return;
                decodeMsg('TMP', gfsFields.tmp);
                transcodeMsg('TMP', gfsFields.tmp, fmap.temperature);
                gfsFields.tmp.data = [];
                break;
            case MSG_TYPES.TCDC:
                decodeMsg('TCDC', gfsFields.tcdc);
                transcodeCloudCoverage();
                gfsFields.tcdc.data = [];
                break;
            case MSG_TYPES.UGRD:
                decodeMsg('UGRD', gfsFields.ugrd);
                break;
            case MSG_TYPES.VGRD:
                decodeMsg('VGRD', gfsFields.vgrd);
                transcodeWinds();
                gfsFields.ugrd.data = [];
                gfsFields.vgrd.data = [];
                break;
            case MSG_TYPES.PRES:
                decodeMsg('PRES', gfsFields.pres);
                transcodeFogAltitude();
                gfsFields.pres.data = [];
                break;
            case MSG_TYPES.HGT:
                decodeMsg('HGT', gfsFields.hgt);
                transcodeCloudHeights();
                gfsFields.hgt.data = [];
                break;
            case MSG_TYPES.PRATE:
                decodeMsg('PRATE', gfsFields.prate);
                transcodeShowers();
                gfsFields.prate.data = [];
                break;
            case MSG_TYPES.APCP:
                decodeMsg('APCP', gfsFields.apcp);
                gfsFields.apcp.data = [];
                break;
            case MSG_TYPES.ACPCP:
                decodeMsg('ACPCP', gfsFields.acpcp);
                gfsFields.acpcp.data = [];
                break;
            default:
                gfsDebug('Unknown message type', getMsgType());
        }
    }

    function setFmap2D(array2d, value) {
        for (let y = 0; y < fmap.dimension.y; y += 1) {
            array2d.push(new Array(fmap.dimension.x).fill(value));
        }
    }

    function initFmap2D(array2d) {
        setFmap2D(array2d, 0);
    }

    function createWindLayers() {
        const rows = fmap.dimension.y;
        const cols = fmap.dimension.x;
        const altitudes = 10;
        for (let y = 0; y < rows; y += 1) {
            const row = [];
            for (let x = 0; x < cols; x += 1) {
                const layers = [];
                for (let alt = 0; alt < altitudes; alt += 1) {
                    layers.push({ direction: 0, speed: 0 });
                }
                row.push(layers);
            }
            fmap.wind.push(row);
        }
    }

    function initializeFmap() {
        const size = 59;
        fmap = {
            time: '',
            version: TARGET_FMAP_VERSION,
            changed: false,
            scaler: 1,
            dimension: { x: size, y: size },
            airmass: { direction: 0, speed: 0 },
            turbulence: { top: null, bottom: null },
            contrail: [],
            cells: size * size,
            type: [],
            pressure: [],
            temperature: [],
            wind: [],
            cloud: {
                base: [],
                top: [],
                cover: [],
                size: [],
                type: []
            },
            shower: [],
            visibility: [],
            fog: [],
            analytics: {
                pressure_min: Infinity,
                pressure_max: -Infinity,
                temperature_min: Infinity,
                temperature_max: -Infinity
            }
        };

        initFmap2D(fmap.type);
        fmap.type.forEach(row => row.fill(1));
        initFmap2D(fmap.pressure);
        initFmap2D(fmap.temperature);
        initFmap2D(fmap.visibility);
        initFmap2D(fmap.fog);
        initFmap2D(fmap.shower);
        initFmap2D(fmap.cloud.base);
        initFmap2D(fmap.cloud.top);
        initFmap2D(fmap.cloud.cover);
        initFmap2D(fmap.cloud.size);
        initFmap2D(fmap.cloud.type);
        createWindLayers();
    }

    function resetState() {
        initializeFmap();
        gfsFile = {
            offset: 0,
            bytes: [],
            msg_cnt: 0
        };
        gfsMsg = {
            s0: { name: 'Indicator', section: 0, offset: 0, grib: [], discipline: 0, edition: 0, size: 0 },
            s1: { name: 'Identification', offset: 16, size: 0, section: 1 },
            s2: { name: 'Local Use', offset: 0, size: 0, section: 2 },
            s3: { name: 'Grid Definition', offset: 0, size: 0, section: 3, def: {} },
            s4: { name: 'Product Definition', offset: 0, size: 0, section: 4, def: {} },
            s5: { name: 'Data Representation', offset: 0, size: 0, section: 5, def: {} },
            s6: { name: 'Bitmap', offset: 0, size: 0, section: 6, bitmap: [] },
            s7: { name: 'Data', offset: 0, size: 0, section: 7, data: [] },
            s8: { name: 'End', offset: 0, size: 4, tag: '' }
        };
        gfsFields = {
            prmsl: { name: 'PRMSL', offset: 0, scale: 0.01, level: -1, data: [] },
            vis: { name: 'VIS', offset: 0, scale: 0.001, level: -1, data: [] },
            tmp: { name: 'TMP', offset: -273.15, scale: 1, level: -1, data: [] },
            tcdc: { name: 'TCDC', offset: 0, scale: 0.125, level: -1, data: [] },
            ugrd: { name: 'UGRD', offset: 0, scale: 1.944, level: -1, data: [] },
            vgrd: { name: 'VGRD', offset: 0, scale: 1.944, level: -1, data: [] },
            pres: { name: 'PRES', offset: 0, scale: 0.01, level: -1, data: [] },
            hgt: { name: 'HGT', offset: 0, scale: 1, level: -1, data: [] },
            prate: { name: 'PRATE', offset: 0, scale: 3600, level: -1, data: [] },
            apcp: { name: 'APCP', level: -1, data: [] },
            acpcp: { name: 'ACPCP', level: -1, data: [] }
        };
    }

    function processGrib2(buffer) {
        resetState();
        gfsFile.bytes = new Uint8Array(buffer);
        gfsFile.offset = 0;
        gfsFile.msg_cnt = 0;

        while (gfsFile.offset < gfsFile.bytes.length - 4) {
            gfsFile.msg_cnt += 1;
            readMessage();
            processMessage();
        }

        determineWeatherType();
        computeAirmass();
        fmap.time = forecastTimestamp();
        fmap.changed = true;
        return {
            fmap,
            rows: fmap.dimension.y,
            columns: fmap.dimension.x,
            version: fmap.version,
            nodeCount: fmap.cells,
            cellSpacingKm: fmap.scaler,
            anchor: [0, 0, 0, 0, 0, 0],
            totalCells: fmap.cells
        };
    }

    async function fetchGfsFmap(options = {}) {
        const date = normalizeDateString(options.date);
        const cycle = normalizeCycle(options.cycle);
        const forecastHour = normalizeForecastHour(options.forecastHour);
        const bounds = options.bounds || DEFAULT_BOUNDS;
        const variants = buildRequestVariants(date, cycle);

        let lastError = null;
        for (const variant of variants) {
            const url = constructUrl(variant.date, variant.cycle, forecastHour, bounds);
            try {
                const response = await fetchWithFallback(url);
                const buffer = await response.arrayBuffer();
                const baseName = buildForecastBasename(variant.date, variant.cycle, forecastHour);
                await saveRawGribPayload(buffer, `${baseName}.grib2`);
                const product = processGrib2(buffer);
                const filename = `${baseName}.fmap`;
                product.filename = filename;
                product.meta = {
                    date: variant.date,
                    cycle: variant.cycle,
                    forecastHour,
                    bounds
                };
                return product;
            } catch (error) {
                lastError = error;
                if (error?.status === 404) {
                    continue;
                }
                break;
            }
        }

        throw lastError || new Error('No GFS data available');
    }

    window.fetchGfsFmap = fetchGfsFmap;
})();

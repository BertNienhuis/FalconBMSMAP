let markerLayer = null;
let markerSource = null;
let isMarkerMode = false;
let markerClickHandler = null;

function initMarkerTool(map) {
    // 🔁 Completely reset marker layer and source on theater switch
    if (markerLayer) {
        map.removeLayer(markerLayer);
    }

    markerSource = new ol.source.Vector();
    markerLayer = new ol.layer.Vector({ source: markerSource });
    map.addLayer(markerLayer);

    window.markerSource = markerSource;
    window.markerLayer = markerLayer;

    // 🔁 Remove any previous click handler
    if (markerClickHandler) {
        map.un('click', markerClickHandler);
    }

    // ✅ Define and attach a fresh handler
    markerClickHandler = function (e) {
        const clickedFeature = map.forEachFeatureAtPixel(e.pixel, f => f, {
            layerFilter: l => l === markerLayer
        });

        if (clickedFeature && markerSource.hasFeature(clickedFeature) && isMarkerMode) {
            markerSource.removeFeature(clickedFeature);
            return;
        }

        if (!isMarkerMode) return;

        const identity = document.querySelector('input[name="marker-identity"]:checked')?.value;
        const domain = document.getElementById('marker-domain')?.value;
        const type = document.getElementById('marker-type')?.value;

        if (!identity || !domain || !type) return;

        const sanitizedType = type.toLowerCase().replace(/\s+/g, '_');
        const fileName = `${sanitizedType}_${identity}.svg`;
        const imageUrl = `milspec_icons/${fileName}`;

        const marker = new ol.Feature({
            geometry: new ol.geom.Point(e.coordinate),
            iconUrl: imageUrl
        });

        marker.setStyle(getMarkerStyle(marker));
        markerSource.addFeature(marker);
    };

    map.on('click', markerClickHandler);

    // 🔧 Rebind UI
    const domainSelect = document.getElementById('marker-domain');
    domainSelect?.addEventListener('change', (e) => {
        populateMarkerTypes(e.target.value);
        updateIdentityOptions();
        updateMarkerPreview();
    });

    const typeSelect = document.getElementById('marker-type');
    typeSelect?.addEventListener('change', () => {
        updateIdentityOptions();
        updateMarkerPreview();
    });

    populateMarkerTypes(domainSelect?.value || 'land');
    updateMarkerPreview();
    updateIdentityOptions();
    updateMarkerPreview();
}


function populateMarkerTypes(domain) {
    const typeSelect = document.getElementById('marker-type');
    if (!typeSelect) return;

    typeSelect.innerHTML = '';

    const allTypes = {
        land: ['Infantry', 'Air Defence', 'Mechanized', 'Motorized', 'Field Artillery', 'Propelled Artillery', 'Armored', 'Engineer', 'Supply'],
        air: ['Attack', 'Bomber', 'Fighter', 'Fighter Bomber', 'Cargo', 'Jammer', 'Tanker', 'Reconnaisance', 'Airborne Early Warning', 'Rotary Wing'],
        sea: ['Carrier', 'Surface Combatant', 'Merchant Ship']
    };

    const types = allTypes[domain] || [];
    types.forEach(type => {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = type.charAt(0).toUpperCase() + type.slice(1);
        typeSelect.appendChild(opt);
    });
}

function updateMarkerPreview() {
    const identity = document.querySelector('input[name="marker-identity"]:checked')?.value;
    const type = document.getElementById('marker-type')?.value;
    const previewImg = document.getElementById('marker-preview-img');

    const sanitizedType = type.toLowerCase().replace(/\s+/g, '_');
    const fileName = `${sanitizedType}_${identity}.svg`;
    const imageUrl = `milspec_icons/${fileName}`;


    if (!previewImg) return;

    if (identity && type) {
        previewImg.src = `milspec_icons/${fileName}`;
    } else {
        previewImg.src = '';
    }
}

function updateIdentityOptions() {
    const domain = document.getElementById('marker-domain')?.value;
    const type = document.getElementById('marker-type')?.value;
    const container = document.getElementById('marker-identity-options');
    if (!container || !domain || !type) return;

    const currentSelected = document.querySelector('input[name="marker-identity"]:checked')?.value;

    const identities = ['friend', 'hostile', 'neutral', 'unknown'];
    const sanitizedType = type.toLowerCase().replace(/\s+/g, '_');

    container.innerHTML = '<legend><strong>Select Identity</strong>:</legend>';

    identities.forEach(identity => {
        const fileName = `${sanitizedType}_${identity}.svg`;
        const imageUrl = `milspec_icons/${fileName}`;

        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.marginBottom = '4px';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'marker-identity';
        input.value = identity;

        if (identity === currentSelected) {
            input.checked = true;
        }

        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = identity;
        img.style.width = '24px';
        img.style.height = '24px';
        img.style.margin = '0 6px';

        label.appendChild(input);
        label.appendChild(img);
        label.appendChild(document.createTextNode(identity.charAt(0).toUpperCase() + identity.slice(1)));
        container.appendChild(label);
    });

    const selectedRadio = container.querySelector('input[name="marker-identity"]:checked');
    if (!selectedRadio && container.querySelector('input[name="marker-identity"][value="hostile"]')) {
        container.querySelector('input[name="marker-identity"][value="hostile"]').checked = true;
    }

    container.querySelectorAll('input[name="marker-identity"]').forEach(radio => {
        radio.addEventListener('change', updateMarkerPreview);
    });

    updateMarkerPreview();
}

function getMarkerStyle(feature) {
    const iconUrl = feature.get('iconUrl') || 'milspec_icons/default.svg';

    return new ol.style.Style({
        image: new ol.style.Icon({
            src: iconUrl,
            scale: 0.1,
            anchor: [0.5, 1],
            anchorXUnits: 'fraction',
            anchorYUnits: 'fraction'
        })
    });
}

window.getMarkerStyle = getMarkerStyle; // Make it globally accessible
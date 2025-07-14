let markerLayer = null;
let markerSource = null;
let isMarkerMode = false;

function initMarkerTool(map) {
    // Create vector source + layer
    markerSource = new ol.source.Vector();
    markerLayer = new ol.layer.Vector({ source: markerSource });
    map.addLayer(markerLayer);

    // Handle click to add/remove marker
    map.on('click', (e) => {
        if (!isMarkerMode) return;

        const identity = document.getElementById('marker-identity')?.value;
        const domain = document.getElementById('marker-domain')?.value;
        const type = document.getElementById('marker-type')?.value;

        if (!identity || !domain || !type) return;

        const fileName = `${type}_${identity}.svg`;
        const imageUrl = `milspec_icons/${fileName}`;

        const existing = map.forEachFeatureAtPixel(e.pixel, f => f, {
            layerFilter: l => l === markerLayer
        });

        if (existing) {
            markerSource.removeFeature(existing);
            return;
        }

        const marker = new ol.Feature({
            geometry: new ol.geom.Point(e.coordinate)
        });

        marker.setStyle(new ol.style.Style({
            image: new ol.style.Icon({
                src: imageUrl,
                scale: 0.1,
                anchor: [0.5, 1]
            })
        }));

        markerSource.addFeature(marker);
    });

    

    // Populate dropdowns and hook up preview update
    const domainSelect = document.getElementById('marker-domain');
    const identitySelect = document.getElementById('marker-identity');
    const typeSelect = document.getElementById('marker-type');

    domainSelect?.addEventListener('change', (e) => {
        populateMarkerTypes(e.target.value);
        updateMarkerPreview();
    });

    identitySelect?.addEventListener('change', updateMarkerPreview);
    typeSelect?.addEventListener('change', updateMarkerPreview);

    // Initial population
    populateMarkerTypes(domainSelect?.value || 'land');
    updateMarkerPreview();
}

function populateMarkerTypes(domain) {
    const typeSelect = document.getElementById('marker-type');
    if (!typeSelect) return;

    typeSelect.innerHTML = '';

    const allTypes = {
        land: ['Infantry','Air Defence', 'Mechanized', 'Motorized' ,'Field Artillery', 'Propelled Artillery' , 'Armored' , 'Engineer' , 'Supply' ],
        air: ['Attack', 'Bomber', 'Fighter' , 'Fighter Bomber', 'Cargo' , 'Jammer', 'Tanker' , 'Reconnaisance', 'Airborne Early Warning', 'Rotary Wing'],
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
    const identity = document.getElementById('marker-identity')?.value;
    const type = document.getElementById('marker-type')?.value;
    const previewImg = document.getElementById('marker-preview-img');

    const sanitizedType = type.toLowerCase().replace(/\s+/g, '_');
    const fileName = `${sanitizedType}_${identity}.svg`;
    const imageUrl = `milspec_icons/${fileName}`;


    if (!previewImg) return;

    if (identity && type) {
        const fileName = `${type}_${identity}.svg`;
        previewImg.src = `milspec_icons/${fileName}`;
    } else {
        previewImg.src = '';
    }
}

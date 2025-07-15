let bullseyeLayer = null;
let bullseyeFeature = null;
let isBullseyeMode = false;
let bullseyeDragPan = null;
let bullseyeModifyInteraction = null;

let bullseyeRings = [];
let bullseyeRadials = [];

function drawBullseye(map, centerCoord) {
  if (bullseyeLayer) {
    map.removeLayer(bullseyeLayer);
  }

  bullseyeRings = [];
  bullseyeRadials = [];

  const source = new ol.source.Vector();
  bullseyeLayer = new ol.layer.Vector({ source });
  map.addLayer(bullseyeLayer);

  const scale = window.getCurrentScale?.() || 0.00976;
  const feetPerPixel = 1 / scale;
  const feetPerNM = 6076.12;
  const nmToMapUnits = (nm) => nm * feetPerNM / feetPerPixel;

  const ringCount = 6;
  const ringSpacingNM = 30;
  const radiusPx = nmToMapUnits(ringCount * ringSpacingNM);

  for (let i = 1; i <= ringCount; i++) {
    const radius = nmToMapUnits(i * ringSpacingNM);
    const circle = new ol.geom.Circle(centerCoord, radius);
    const feature = new ol.Feature(circle);
    feature.setStyle(new ol.style.Style({
      stroke: new ol.style.Stroke({ color: 'rgb(19 89 0 / 95%)', width: 1 })
    }));
    source.addFeature(feature);
    bullseyeRings.push(feature);
  }

  for (let angle = 0; angle < 360; angle += 30) {
    const rad = angle * Math.PI / 180;
    const dx = Math.sin(rad) * radiusPx;
    const dy = Math.cos(rad) * radiusPx;
    const line = new ol.geom.LineString([
      centerCoord,
      [centerCoord[0] + dx, centerCoord[1] + dy]
    ]);
    const feature = new ol.Feature(line);
    feature.setStyle(new ol.style.Style({
      stroke: new ol.style.Stroke({ color: 'rgb(19 89 0 / 95%)', width: 1 })
    }));
    source.addFeature(feature);
    bullseyeRadials.push(feature);
  }

  bullseyeFeature = new ol.Feature(new ol.geom.Point(centerCoord));
  source.addFeature(bullseyeFeature);
}


function liveUpdateBullseye() {
  const center = bullseyeFeature.getGeometry().getCoordinates();
  updateBullseyeGeometry(center);
}


function enableBullseyeMode(map) {
  if (isBullseyeMode) return;
  isBullseyeMode = true;

  document.getElementById('bullseye-button').classList.add('active');

  bullseyeFeature.setStyle(new ol.style.Style({
    image: new ol.style.Circle({
      radius: 5,
      fill: new ol.style.Fill({ color: '#00AAFF' }),
      stroke: new ol.style.Stroke({ color: 'white', width: 1 })
    })
  }));

  bullseyeDragPan = map.getInteractions().getArray().find(i => i instanceof ol.interaction.DragPan);
  bullseyeDragPan?.setActive(false);
  map.getTargetElement().style.cursor = 'move';

  if (bullseyeModifyInteraction) {
    map.removeInteraction(bullseyeModifyInteraction);
    bullseyeModifyInteraction = null;
  }

  const collection = new ol.Collection([bullseyeFeature]);
  bullseyeModifyInteraction = new ol.interaction.Modify({
    features: collection,
    // 👇 This disables default Modify visuals when not in use
    style: (feature) => (isBullseyeMode ? null : [])
  });

  bullseyeModifyInteraction.on('modifystart', () => {
    map.on('pointerdrag', handleBullseyeDrag);
  });

  bullseyeModifyInteraction.on('modifyend', () => {
    map.un('pointerdrag', handleBullseyeDrag);
  });

  map.addInteraction(bullseyeModifyInteraction);
}




function disableBullseyeMode(map) {
  if (!isBullseyeMode) return;
  isBullseyeMode = false;

  document.getElementById('bullseye-button').classList.remove('active');
  bullseyeFeature.setStyle(null);
  bullseyeDragPan?.setActive(true);
  map.getTargetElement().style.cursor = '';

  if (bullseyeModifyInteraction) {
    map.removeInteraction(bullseyeModifyInteraction);
    bullseyeModifyInteraction = null;
  }
}


function updateBullseyeGeometry(centerCoord, updatePoint = true) {
  const scale = window.getCurrentScale?.() || 0.00976;
  const feetPerPixel = 1 / scale;
  const feetPerNM = 6076.12;
  const nmToMapUnits = (nm) => nm * feetPerNM / feetPerPixel;

  const ringSpacingNM = 30;
  const radiusNM = ringSpacingNM * bullseyeRings.length;
  const radiusPx = nmToMapUnits(radiusNM);

  // Update rings
  bullseyeRings.forEach((feature, index) => {
    const radius = nmToMapUnits((index + 1) * ringSpacingNM);
    const geom = feature.getGeometry();
    if (geom instanceof ol.geom.Circle) {
      geom.setCenter(centerCoord);
      geom.setRadius(radius);
    }
  });

  // Update radials
  bullseyeRadials.forEach((feature, index) => {
    const angleDeg = index * 30;
    const angleRad = angleDeg * Math.PI / 180;
    const dx = Math.sin(angleRad) * radiusPx;
    const dy = Math.cos(angleRad) * radiusPx;
    const geom = feature.getGeometry();
    if (geom instanceof ol.geom.LineString) {
      geom.setCoordinates([
        centerCoord,
        [centerCoord[0] + dx, centerCoord[1] + dy]
      ]);
    }
  });

  if (updatePoint && bullseyeFeature) {
    bullseyeFeature.getGeometry().setCoordinates(centerCoord);
  }
}


function handleBullseyeDrag() {
  if (!bullseyeFeature) return;
  requestAnimationFrame(() => {
    const center = bullseyeFeature.getGeometry().getCoordinates();
    updateBullseyeGeometry(center, false);
  });
}
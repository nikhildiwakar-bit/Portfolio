/* ---------- fullscreen toggle ---------- */
const fullscreenBtn = document.getElementById('fullscreenBtn');
if(fullscreenBtn){
  fullscreenBtn.addEventListener('click', ()=>{
    const el = document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if(!isFs){
      if(el.requestFullscreen) el.requestFullscreen();
      else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } else {
      if(document.exitFullscreen) document.exitFullscreen();
      else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', ()=>{
    fullscreenBtn.textContent = (document.fullscreenElement) ? '✕' : '⛶';
  });
}

/* ---------- ambient school icons ---------- */
const starsEl = document.getElementById('stars');
const schoolIcons = ['🎓','📚','✏️','🏫','🔔','🖊️','📐'];
const iconSpots = [
  {x:4,  y:6},  {x:13, y:12}, {x:87, y:12}, {x:96, y:6},
  {x:6,  y:20}, {x:15, y:26}, {x:85, y:26}, {x:94, y:20},
  {x:4,  y:34}, {x:13, y:40}, {x:87, y:40}, {x:96, y:34},
  {x:6,  y:48}, {x:15, y:54}, {x:85, y:54}, {x:94, y:48},
  {x:4,  y:62}, {x:13, y:68}, {x:87, y:68}, {x:96, y:62},
  {x:6,  y:76}, {x:15, y:82}, {x:85, y:82}, {x:94, y:76},
  {x:4,  y:90}, {x:13, y:95}, {x:87, y:95}, {x:96, y:90}
];
iconSpots.forEach((pos,i)=>{
  const s=document.createElement('span');
  s.textContent = schoolIcons[i % schoolIcons.length];
  s.style.left = pos.x+'%';
  s.style.top = pos.y+'%';
  s.style.fontSize = (13+Math.random()*5)+'px';
  s.style.animationDuration=(4+Math.random()*3)+'s';
  s.style.animationDelay=(Math.random()*3)+'s';
  starsEl.appendChild(s);
});

/* ---------- slingshot logic ---------- */
const scene = document.getElementById('scene');
const heart = document.getElementById('heart');
const bandL = document.getElementById('bandL');
const bandR = document.getElementById('bandR');
const slingSvg = document.getElementById('slingSvg');
const slingWrap = document.getElementById('slingWrap');
const hint = document.getElementById('hint');
const pullLabel = document.getElementById('pullLabel');
const reveal = document.getElementById('reveal');
const blooms = document.querySelectorAll('.bloom');

let restX, restY, anchorL, anchorR, dragging=false, hasFired=false;

function svgToScreen(svg, x, y){
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: rect.left + (x/vb.width)*rect.width,
    y: rect.top + (y/vb.height)*rect.height
  };
}

function layout(){
  const p = svgToScreen(slingSvg,150,55);
  restX = p.x; restY = p.y;
  anchorL = svgToScreen(slingSvg,120,0);
  anchorR = svgToScreen(slingSvg,180,0);
  placeHeart(restX,restY);
}

let cachedWrapRect=null, cachedSlingRect=null, cachedHeartW=0, cachedHeartH=0, cachedVb=null;

function placeHeart(x,y){
  heart.style.transform = 'none';
  const r = heart.getBoundingClientRect();
  const wrapRect = slingWrap.getBoundingClientRect();
  heart.style.left = (x - wrapRect.left - r.width/2) + 'px';
  heart.style.top = (y - wrapRect.top - r.height/2) + 'px';
  updateBands(x,y);
}

function updateBands(x,y){
  const vb = slingSvg.viewBox.baseVal;
  const slingRect = slingSvg.getBoundingClientRect();
  const toSvg = (px,py)=>({
    x: ((px-slingRect.left)/slingRect.width)*vb.width,
    y: ((py-slingRect.top)/slingRect.height)*vb.height
  });
  const pt = toSvg(x,y);
  bandL.setAttribute('x2', pt.x); bandL.setAttribute('y2', pt.y);
  bandR.setAttribute('x2', pt.x); bandR.setAttribute('y2', pt.y);
}

/* Fast path used while actively dragging: reuses rects captured once at
   drag-start instead of forcing a layout reflow on every pointer move. */
function placeHeartFast(x,y){
  const left = x - cachedWrapRect.left - cachedHeartW/2;
  const top = y - cachedWrapRect.top - cachedHeartH/2;
  heart.style.left = left + 'px';
  heart.style.top = top + 'px';
  const sx = ((x - cachedSlingRect.left)/cachedSlingRect.width)*cachedVb.width;
  const sy = ((y - cachedSlingRect.top)/cachedSlingRect.height)*cachedVb.height;
  bandL.setAttribute('x2', sx); bandL.setAttribute('y2', sy);
  bandR.setAttribute('x2', sx); bandR.setAttribute('y2', sy);
}

function pointerPos(e){
  if(e.touches && e.touches[0]) return {x:e.touches[0].clientX,y:e.touches[0].clientY};
  return {x:e.clientX,y:e.clientY};
}

/* rest position viewport-relative hota hai, isliye scroll ke baad purana ho jaata hai — drag shuru hone par fresh lete hain */
function refreshRest(){
  const p = svgToScreen(slingSvg,150,55);
  restX = p.x; restY = p.y;
}

function startDrag(e){
  if(hasFired) return;
  refreshRest();
  dragging = true;
  hint.classList.add('hidden');
  pullLabel.classList.add('hidden');
  heart.style.transition='none';
  heart.style.transform = 'none';
  cachedWrapRect = slingWrap.getBoundingClientRect();
  cachedSlingRect = slingSvg.getBoundingClientRect();
  cachedVb = slingSvg.viewBox.baseVal;
  const hr = heart.getBoundingClientRect();
  cachedHeartW = hr.width; cachedHeartH = hr.height;
  e.preventDefault();
}

function moveDrag(e){
  if(!dragging) return;
  const p = pointerPos(e);
  const dx = p.x-restX, dy = p.y-restY;
  const maxR = 70;
  const dist = Math.min(Math.hypot(dx,dy), maxR);
  const ang = Math.atan2(dy,dx);
  const nx = restX + Math.cos(ang)*dist;
  const ny = restY + Math.max(Math.sin(ang)*dist, -4);
  placeHeartFast(nx,ny);
  e.preventDefault();
}

function endDrag(e){
  if(!dragging) return;
  dragging = false;
  const r = heart.getBoundingClientRect();
  const curX = r.left + r.width/2, curY = r.top + r.height/2;
  const pullDist = Math.hypot(curX-restX, curY-restY);

  if(pullDist < 18){
    snapBack();
    return;
  }
  fire(curX,curY);
}

function snapBack(){
  heart.style.transition='left .4s cubic-bezier(.34,1.56,.64,1), top .4s cubic-bezier(.34,1.56,.64,1)';
  placeHeart(restX,restY);
  hint.classList.remove('hidden');
  pullLabel.classList.remove('hidden');
}

function fire(curX,curY){
  hasFired = true;
  const treeRect = document.getElementById('treeSvg').getBoundingClientRect();
  const targetX = treeRect.left + treeRect.width*0.5;
  const targetY = treeRect.top + treeRect.height*0.4;

  const startX = curX, startY = curY;
  const ctrlX = restX + (restX-curX)*1.4;
  const ctrlY = Math.min(curY, restY) - 120;

  const duration = 650;
  const t0 = performance.now();
  heart.classList.add('flying');
  const flyWrapRect = slingWrap.getBoundingClientRect();
  const flyHeartRect = heart.getBoundingClientRect();

  function step(now){
    let t = Math.min((now-t0)/duration, 1);
    const it = 1-t;
    const x = it*it*startX + 2*it*t*ctrlX + t*t*targetX;
    const y = it*it*startY + 2*it*t*ctrlY + t*t*targetY;
    heart.style.left = (x - flyWrapRect.left - flyHeartRect.width/2) + 'px';
    heart.style.top = (y - flyWrapRect.top - flyHeartRect.height/2) + 'px';
    heart.style.transform = 'scale(' + (1 - 0.3*t) + ') rotate(' + (t*260) + 'deg)';
    if(t<1){
      requestAnimationFrame(step);
    } else {
      heart.classList.add('hidden');
      bloomTree();
    }
  }
  requestAnimationFrame(step);
}

function bloomTree(){
  blooms.forEach((b,i)=>{
    setTimeout(()=>{
      b.classList.add('show');
    }, i*90);
  });
  spawnPetals();
  setTimeout(()=>{
    reveal.classList.add('show');
  }, blooms.length*90 + 400);
}

function spawnPetals(){
  const emojis = ['💙','🎉','✨'];
  for(let i=0;i<22;i++){
    const p = document.createElement('div');
    p.className='petal';
    p.textContent = emojis[Math.floor(Math.random()*emojis.length)];
    p.style.left = Math.random()*100+'%';
    p.style.animationDuration = (3+Math.random()*2.5)+'s';
    p.style.animationDelay = (Math.random()*1.2)+'s';
    p.style.fontSize = (10+Math.random()*10)+'px';
    scene.appendChild(p);
    setTimeout(()=>p.remove(), 7000);
  }
}

heart.addEventListener('mousedown', startDrag);
heart.addEventListener('touchstart', startDrag, {passive:false});
window.addEventListener('mousemove', moveDrag);
window.addEventListener('touchmove', moveDrag, {passive:false});
window.addEventListener('mouseup', endDrag);
window.addEventListener('touchend', endDrag);
window.addEventListener('resize', ()=>{ if(!hasFired) layout(); });

window.addEventListener('load', layout);
setTimeout(layout, 60);

/* ---------- celebration ---------- */
const playBtn = document.getElementById('playBtn');
const videoBlock = document.getElementById('videoBlock');
const celebrateFrame = document.getElementById('celebrateFrame');
let celebrated = false;
let balloonTimer = null;

function spawnConfettiBurst(){
  const colors = ['#0C54A0','#1185FF','#B62C2C','#FF3C3C','#ffffff'];
  for(let i=0;i<50;i++){
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random()*100+'%';
    c.style.width = (5+Math.random()*5)+'px';
    c.style.height = (8+Math.random()*8)+'px';
    c.style.background = colors[Math.floor(Math.random()*colors.length)];
    c.style.borderRadius = Math.random()>0.5 ? '50%' : '2px';
    c.style.animationDuration = (2+Math.random()*2)+'s';
    c.style.animationDelay = (Math.random()*0.8)+'s';
    celebrateFrame.appendChild(c);
    setTimeout(()=>c.remove(), 5000);
  }
}

function spawnBalloonWave(){
  const balloonEmojis = ['🎈','🎈','🎈'];
  const count = 6;
  for(let i=0;i<count;i++){
    const b = document.createElement('div');
    b.className = 'balloon';
    b.textContent = balloonEmojis[Math.floor(Math.random()*balloonEmojis.length)];
    b.style.left = (10+Math.random()*80)+'%';
    b.style.setProperty('--drift', (Math.random()*40-20)+'px');
    b.style.animationDuration = (1.8+Math.random()*0.8)+'s';
    b.style.animationDelay = (Math.random()*0.25)+'s';
    celebrateFrame.appendChild(b);
    setTimeout(()=>b.remove(), 2800);
  }
}

function startCelebration(){
  celebrateFrame.classList.add('play');
  spawnConfettiBurst();
  spawnBalloonWave();
  balloonTimer = setInterval(spawnBalloonWave, 2200);
}

function stopCelebration(){
  if(balloonTimer){ clearInterval(balloonTimer); balloonTimer = null; }
}

playBtn.addEventListener('click', ()=>{
  videoBlock.classList.toggle('open');
  if(videoBlock.classList.contains('open')){
    videoBlock.scrollIntoView({behavior:'smooth', block:'start'});
    playBtn.textContent = 'Hide ↑';
    if(!celebrated){
      celebrated = true;
      setTimeout(startCelebration, 80);
    } else {
      balloonTimer = setInterval(spawnBalloonWave, 2200);
    }
  } else {
    playBtn.textContent = 'Watch this ↓';
    stopCelebration();
  }
});
/* ---------- Nucleus data (photo + years) ---------- */
/* TODO: API key / endpoint / employee id milne par yahan bharna hai */
const NUCLEUS_CONFIG = {
  apiUrl: '/api/employee',   // Nucleus se connect karte waqt yahan asli URL aayega
  apiKey: '',                // Nucleus API key (localhost mock me zaroorat nahi)
  getEmployeeId: ()=> new URLSearchParams(location.search).get('empId') || '101'
};

const photoImg = document.getElementById('photoImg');
const photoPlaceholder = document.getElementById('photoPlaceholder');
const empName = document.getElementById('empName');
const yearsBadge = document.getElementById('yearsBadge');
const yearsNum = document.getElementById('yearsNum');

function applyEmployee(data){
  if(data.photoUrl){
    photoImg.onload = ()=>{
      photoImg.style.display = 'block';
      photoPlaceholder.style.display = 'none';
    };
    photoImg.src = data.photoUrl;
  }
  if(data.name){
    empName.textContent = data.name;
    empName.style.display = '';
  }
  if(data.years != null && data.years !== ''){
    yearsNum.textContent = data.years;
    yearsBadge.style.display = '';
  }
}

async function fetchFromNucleus(){
  const empId = NUCLEUS_CONFIG.getEmployeeId();
  if(!NUCLEUS_CONFIG.apiUrl || !empId) return;
  try{
    const res = await fetch(NUCLEUS_CONFIG.apiUrl + '?empId=' + encodeURIComponent(empId), {
      headers: NUCLEUS_CONFIG.apiKey ? { 'Authorization': 'Bearer ' + NUCLEUS_CONFIG.apiKey } : {}
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    /* response ke field names Nucleus ke hisaab se yahan map honge */
    applyEmployee({ name: json.name, photoUrl: json.photoUrl, years: json.years });
  }catch(err){
    console.error('Nucleus fetch failed', err);
  }
}
fetchFromNucleus();

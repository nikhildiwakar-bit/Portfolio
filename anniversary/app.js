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
  s.style.fontSize = [13,15,17][i%3]+'px';
  s.style.animationDuration=(4+Math.random()*3)+'s';
  s.style.animationDelay=(Math.random()*3)+'s';
  starsEl.appendChild(s);
});

/* ---------- slingshot logic ---------- */
/* Heart sirf transform se move hota hai (left/top nahi) — isse har move par layout/repaint nahi hota.
   Pointer Events + pointer capture: mouse, touch aur pen teeno ek hi code se. */
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

/* positions sling-wrap ke andar (local px), viewport se independent — scroll ka asar nahi */
let restX=0, restY=0, heartW=0, heartH=0, slingW=1, slingH=1;
let dragging=false, hasFired=false, pointerId=null, grabDX=0, grabDY=0, wrapLeft=0, wrapTop=0;
let curX=0, curY=0, pendingX=0, pendingY=0, rafId=0;
const VB_W=300, VB_H=110;

function setHeart(x,y,extra){
  heart.style.transform = 'translate3d(' + (x-heartW/2) + 'px,' + (y-heartH/2) + 'px,0)' + (extra||'');
}
function setBands(x,y){
  const sx = x/slingW*VB_W, sy = y/slingH*VB_H;
  bandL.setAttribute('x2', sx); bandL.setAttribute('y2', sy);
  bandR.setAttribute('x2', sx); bandR.setAttribute('y2', sy);
}

function measure(){
  slingW = slingWrap.clientWidth || 1;
  slingH = slingWrap.clientHeight || 1;
  heartW = heart.offsetWidth; heartH = heart.offsetHeight;
  restX = slingW*150/VB_W; restY = slingH*55/VB_H;
}
function layout(){
  if(dragging || hasFired) return;
  measure();
  curX = restX; curY = restY;
  setHeart(restX,restY);
  setBands(restX,restY);
}

function flush(){
  rafId = 0;
  curX = pendingX; curY = pendingY;
  setHeart(curX,curY);
  setBands(curX,curY);
}

function startDrag(e){
  if(hasFired || dragging) return;
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  dragging = true;
  pointerId = e.pointerId;
  try{ heart.setPointerCapture(pointerId); }catch(_){}
  hint.classList.add('hidden');
  pullLabel.classList.add('hidden');
  heart.style.transition = 'none';
  const r = slingWrap.getBoundingClientRect();
  wrapLeft = r.left; wrapTop = r.top;
  grabDX = (e.clientX - wrapLeft) - curX;
  grabDY = (e.clientY - wrapTop) - curY;
  e.preventDefault();
}

function moveDrag(e){
  if(!dragging || e.pointerId !== pointerId) return;
  const px = e.clientX - wrapLeft - grabDX, py = e.clientY - wrapTop - grabDY;
  const dx = px-restX, dy = py-restY;
  const maxR = 70;
  const dist = Math.min(Math.hypot(dx,dy), maxR);
  const ang = Math.atan2(dy,dx);
  pendingX = restX + Math.cos(ang)*dist;
  pendingY = restY + Math.max(Math.sin(ang)*dist, -4);
  if(!rafId) rafId = requestAnimationFrame(flush);
}

function endDrag(e){
  if(!dragging || e.pointerId !== pointerId) return;
  dragging = false;
  try{ heart.releasePointerCapture(pointerId); }catch(_){}
  pointerId = null;
  if(rafId){ cancelAnimationFrame(rafId); flush(); }
  if(e.type === 'pointercancel' || Math.hypot(curX-restX, curY-restY) < 18){
    snapBack();
    return;
  }
  fire();
}

function snapBack(){
  heart.style.transition = 'transform .4s cubic-bezier(.34,1.56,.64,1)';
  curX = restX; curY = restY;
  setHeart(restX,restY);
  setBands(restX,restY);
  hint.classList.remove('hidden');
  pullLabel.classList.remove('hidden');
}

function fire(){
  hasFired = true;
  heart.style.transition = 'none';
  setBands(restX,restY);
  const treeRect = document.getElementById('treeSvg').getBoundingClientRect();
  const wr = slingWrap.getBoundingClientRect();
  const targetX = treeRect.left + treeRect.width*0.5 - wr.left;
  const targetY = treeRect.top + treeRect.height*0.4 - wr.top;
  const startX = curX, startY = curY;
  const ctrlX = restX + (restX-curX)*1.4;
  const ctrlY = Math.min(curY, restY) - 120;
  const duration = 650;
  const t0 = performance.now();

  function step(now){
    const t = Math.min((now-t0)/duration, 1);
    const it = 1-t;
    const x = it*it*startX + 2*it*t*ctrlX + t*t*targetX;
    const y = it*it*startY + 2*it*t*ctrlY + t*t*targetY;
    setHeart(x,y,' scale(' + (1 - 0.3*t) + ') rotate(' + (t*260) + 'deg)');
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
    setTimeout(()=>{ b.classList.add('show'); }, i*90);
  });
  spawnPetals();
  setTimeout(()=>{ reveal.classList.add('show'); }, blooms.length*90 + 400);
}

function spawnPetals(){
  const emojis = ['💙','🎉','✨'];
  const frag = document.createDocumentFragment();
  const made = [];
  for(let i=0;i<22;i++){
    const p = document.createElement('div');
    p.className='petal';
    p.textContent = emojis[i % emojis.length];
    p.style.left = Math.random()*100+'%';
    p.style.animationDuration = (3+Math.random()*2.5)+'s';
    p.style.animationDelay = (Math.random()*1.2)+'s';
    p.style.fontSize = [12,15,18][i%3]+'px';   /* gine-chune size — har petal par naya font raster nahi */
    p.addEventListener('animationend', ()=>p.remove(), {once:true});
    frag.appendChild(p); made.push(p);
  }
  scene.appendChild(frag);
  setTimeout(()=>made.forEach(p=>p.remove()), 7000);
}

heart.addEventListener('pointerdown', startDrag);
heart.addEventListener('pointermove', moveDrag);
heart.addEventListener('pointerup', endDrag);
heart.addEventListener('pointercancel', endDrag);
heart.addEventListener('lostpointercapture', e=>{ if(dragging) endDrag(Object.assign({}, {pointerId:e.pointerId, type:'pointercancel'})); });

let resizeRaf = 0;
window.addEventListener('resize', ()=>{
  if(resizeRaf) return;
  resizeRaf = requestAnimationFrame(()=>{ resizeRaf = 0; layout(); });
});
layout();
window.addEventListener('load', layout);
if(document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

/* card screen se bahar ho to background icons ki animation rok do */
if('IntersectionObserver' in window){
  new IntersectionObserver(([en])=>{
    starsEl.classList.toggle('paused', !en.isIntersecting);
  }).observe(scene);
}

/* ---------- celebration ---------- */
const playBtn = document.getElementById('playBtn');
const videoBlock = document.getElementById('videoBlock');
const celebrateFrame = document.getElementById('celebrateFrame');
let celebrated = false;
let balloonTimer = null;

function spawnConfettiBurst(){
  const colors = ['#0C54A0','#1185FF','#B62C2C','#FF3C3C','#ffffff'];
  const frag = document.createDocumentFragment();
  for(let i=0;i<40;i++){
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random()*100+'%';
    c.style.width = (5+Math.random()*5)+'px';
    c.style.height = (8+Math.random()*8)+'px';
    c.style.background = colors[Math.floor(Math.random()*colors.length)];
    c.style.borderRadius = Math.random()>0.5 ? '50%' : '2px';
    c.style.animationDuration = (2+Math.random()*2)+'s';
    c.style.animationDelay = (Math.random()*0.8)+'s';
    frag.appendChild(c);
    setTimeout(()=>c.remove(), 5000);
  }
  celebrateFrame.appendChild(frag);
}

function spawnBalloonWave(){
  if(document.hidden) return;
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
    requestAnimationFrame(()=>videoBlock.scrollIntoView({behavior:'smooth', block:'start'}));
    playBtn.textContent = 'Hide ↑';
    if(!celebrated){
      celebrated = true;
      setTimeout(startCelebration, 80);
    } else if(!balloonTimer){
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
  apiUrl: 'data/employees.json', // abhi sample data (GitHub Pages par bhi chalta hai); Nucleus milne par asli URL
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
    let json = await res.json();
    if(json && json[empId]) json = json[empId];   /* sample file me sab employees ek saath hain */
    else if(json && !json.name && !json.photoUrl) return;
    /* response ke field names Nucleus ke hisaab se yahan map honge */
    applyEmployee({ name: json.name, photoUrl: json.photoUrl, years: json.years });
  }catch(err){
    console.error('Nucleus fetch failed', err);
  }
}
fetchFromNucleus();

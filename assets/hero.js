/* First Light. Raw WebGL2, no libraries, no image assets: sky and a still sea below a horizon of its own,
   under the real <h1>, which stays plain HTML throughout.
   Every browser API is feature-tested; anything missing falls back to the designed CSS still. */
const D = document, DE = D.documentElement, WIN = window;
const hero = D.querySelector('.hero'), stage = hero && hero.querySelector('.hero-stage'),
  cvs = hero && hero.querySelector('canvas.sky-gl'), h1 = D.getElementById('welcome'), byl = hero && hero.querySelector('.byline');

if (hero && stage && cvs && h1 && byl) {
  try { firstLight(); } catch (e) { DE.classList.add('nogl'); }
}

function firstLight() {
/* a recorder can drive the scene frame by frame: it sets this flag before load, then calls __tick(ms) */
const MANUAL = WIN.__HERO_MANUAL_CLOCK === true;
/* a contrast check can switch the guard off, to read the raw sky behind the text */
const NOGUARD = WIN.__HERO_NOGUARD === true;
const mqRM = WIN.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let reduced = !!(mqRM && mqRM.matches);
let mclock = 0;
const clock = () => MANUAL ? mclock : performance.now();
const raf = f => requestAnimationFrame(f), caf = id => cancelAnimationFrame(id);

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (a, b, x) => clamp((x - a) / (b - a));
const ss = x => x * x * (3 - 2 * x);

/* ---------- time of day, keyed on scroll progress. sRGB hex in, linear out ---------- */
const lin = h => [1, 3, 5].map(i => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
const BG = '#f7f8f9';   // --bg, oklch(0.978 0.002 255), in sRGB
const KEYS = [
  //  p     zenith     mid        horizon    band(add)  light      (unused)   deep water
  [0.00, '#02050d', '#081026', '#1c2240', '#6e3c1c', '#ffcf9e', '#000000', '#03060e'],
  [0.22, '#030815', '#0c1632', '#26284a', '#8f4c20', '#ffd3a2', '#000000', '#050a18'],
  [0.44, '#1d3566', '#52689c', '#dfa48b', '#ffae70', '#ffe0b8', '#000000', '#1e2546'],
  [0.64, '#6d98cf', '#a8c2e3', '#eef0f3', '#2a2016', '#fff6ea', '#000000', '#6f87ab'],
  [0.86, '#c7d8ec', '#e3ebf4', '#f6f7f9', '#000000', '#ffffff', '#000000', '#cdd7e4'],
  [1.00, BG, BG, BG, '#000000', '#ffffff', BG, BG],
].map(k => [k[0], ...k.slice(1).map(lin)]);
function palette(p) {
  let i = 0; while (i < KEYS.length - 2 && p > KEYS[i + 1][0]) i++;
  const a = KEYS[i], b = KEYS[i + 1], t = seg(a[0], b[0], p);
  const out = []; for (let c = 1; c < a.length; c++) out.push(a[c].map((v, j) => v + (b[c][j] - v) * t));
  return out;
}
const BG_SRGB = [1, 3, 5].map(i => parseInt(BG.slice(i, i + 2), 16) / 255);

/* ---------- scroll ----------
   the stage is pinned for `span`, then scrolls away. the day keeps going for the first half of that exit (`tail`),
   so the page is already rising into view while the last of the daylight clears: there is no empty white beat. */
const TAIL = .5;
let heroTop = 0, span = 1, stageH = 1, tail = 0, forced = null;
function measure() {
  heroTop = hero.getBoundingClientRect().top + scrollY;
  stageH = stage.offsetHeight;
  span = Math.max(1, hero.offsetHeight - stageH);
  tail = stageH * TAIL;
}
const targetP = () => forced !== null ? forced : clamp((scrollY - heroTop) / (span + tail));

/* each line flips from light to ink where the sky behind it crosses over, with hysteresis. measured with the guard off,
   the text standing clear of the horizon (1440x900 and 390x844 agree). the word, at 3:1, reads either way from p .28 to
   .293. the small line, in white, holds 4.5:1 until p .25; in near-black from p .263. so it turns white at dusk, flips in
   the middle of that short gap (the guard carries it across), and settles back to the page's ink once ink holds (p .268) */
let isDay = false, isDay2 = false, isDusk = false, isDay3 = false;
function theme(p) {
  const a = isDay ? p > .284 : p > .288, b = isDay2 ? p > .255 : p > .259;
  const c = isDusk ? p > .195 : p > .2, d = isDay3 ? p > .272 : p > .276;
  if (a !== isDay) { isDay = a; hero.classList.toggle('day', a); }
  if (b !== isDay2) { isDay2 = b; hero.classList.toggle('day2', b); }
  if (c !== isDusk) { isDusk = c; hero.classList.toggle('dusk', c); }
  if (d !== isDay3) { isDay3 = d; hero.classList.toggle('day3', d); }
}
/* without the shader (no WebGL, or reduced motion) the page colour crossfades in over the night once, at a threshold.
   a timed fade never rests at the mid-grey where neither light nor ink text would read. */
let cssDay = true;
function cssHandoff() {
  if (!cssDay) return;
  const p = targetP(), want = isDay ? p > .36 : p > .4;   // just before the hold releases, so the page follows at once
  if (want !== isDay) { isDay = isDay2 = isDay3 = want; for (const c of ['lit', 'day', 'day2', 'day3']) hero.classList.toggle(c, want); }
}
addEventListener('scroll', () => { cssHandoff(); wake(); }, { passive: true });
addEventListener('resize', () => { measure(); cssHandoff(); }, { passive: true });
measure(); cssHandoff();

/* ---------- WebGL ---------- */
const VS = `#version 300 es
in vec2 aP; out vec2 vUv;
void main(){ vUv = aP*.5+.5; gl_Position = vec4(aP,0.,1.); }`;

const SCENE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec2 uRes, uCam, uSun;
uniform float uTime, uHz, uStars, uWhite, uDay, uFoot;
uniform vec2 uGuardMode;
uniform vec4 uCap;
uniform vec2 uGLod, uPx;
uniform vec3 uZen, uMid, uHor, uBand, uSunC, uCTop, uCSha, uBg;
uniform sampler2D uMask;

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f*f*f*(f*(f*6.-15.)+10.);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
const mat2 ROT = mat2(1.6,1.2,-1.2,1.6);
/* cloud tops: slow domain warp for the big swells, billowed octaves for the cauliflower detail */
float cloudH(vec2 p, int oct){
  vec2 w = vec2(noise(p*.27+vec2(3.1,1.7+uTime*.004)), noise(p*.27+vec2(8.3-uTime*.003,5.2)));
  p += (w-.5)*1.8;
  float big = noise(p*.42)*.6 + noise(p*.9+4.2)*.4;
  float s = 0., a = .5;
  for(int i=0;i<6;i++){ if(i>=oct) break; s += a*abs(2.*noise(p)-1.); p = ROT*p + vec2(1.7,9.2); a *= .5; }
  return clamp(smoothstep(.18, .82, big)*.62 + s*.55 - .08, 0., 1.);
}

vec3 SD;
vec3 sky(vec3 rd){
  float e = max(rd.y, 0.);
  vec3 c = mix(uHor, uMid, smoothstep(0., .24, e));
  c = mix(c, uZen, smoothstep(.16, .7, e));
  float az = max(dot(normalize(rd.xz), normalize(SD.xz)), 0.);
  c += uBand*exp(-e*10.)*(.22 + .78*pow(az, 36.));
  float mu = max(dot(rd, SD), 0.);
  c += uSunC*uDay*(pow(mu, 180.)*.55 + pow(mu, 24.)*.22 + pow(mu, 5.)*.07);
  return c;
}


/* the sea: still water a little below the eye. long low swells, and ripples that are small and sharp up close and
   settle into glass far off; glassy slicks drift among them. the water sits a shade darker than the sky, so the
   horizon is one clean line, the way it is in a long-exposure seascape */
const float FAR = 80.;
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz)*p3.zy); }
float wave(vec2 p, float near, float near2){
  float t = uTime;
  /* swells: their crests bend and their height comes and goes along their length, so no crest ever lies
     dead level across the whole view (a level one reads as a cut, not a wave) */
  vec2 q = p + vec2(0., 2.2*noise(p*vec2(.09, .05) + 3.3) + .7*noise(p*vec2(.4, .26) + 1.7));   // a second, smaller bend: no two crests evenly spaced
  float sw = .35 + .65*noise(p*vec2(.16, .07) + 8.1);
  float h = sw*(.010*sin(q.y*1.05 + q.x*.17 + t*.50) + .008*sin(q.y*1.85 - q.x*.31 + t*.74 + 1.7))
          + .006*sin(q.y*3.2 + q.x*.55 - t*1.05 + .4);
  /* ripples: nearly as wide as they are deep on the water itself (perspective does the squashing), two sizes */
  float slick = .25 + .75*smoothstep(.3, .7, noise(p*vec2(.07, .16) + vec2(t*.008, -t*.012)));
  h += slick*.013*noise(p*vec2(2.1, 2.9) + vec2(t*.05, t*.32));
  h += slick*near*.006*noise(p*vec2(4.7, 6.3) + vec2(-t*.08, t*.55));
  /* up close, a finer set still: the water nearest us has the most going on, never the least */
  h += (.4 + .6*slick)*near2*.004*noise(p*vec2(9.5, 13.) + vec2(t*.13, -t*.9));
  return h;
}
/* where a direction lands on the screen: the inverse of the camera ray in main() */
float glint(vec2 p, vec3 rd, vec3 n, float cs){
  vec2 cell = floor(p/cs);
  float ph = floor(uTime*3.2 + hash12(cell)*9.);
  vec2 r2 = hash22(cell + ph*.731), r3 = hash22(cell*1.93 + ph*.37 + 5.1);
  vec2 f = fract(p/cs) - .2 - .6*r3;                      // the flash sits anywhere in its cell, not on a grid
  vec3 nf = normalize(n + vec3(r2.x - .5, 0., r2.y - .5)*.2);
  float size = mix(26., 140., r3.x*r3.x);                  // mostly pinpricks, now and then a bigger flare
  return pow(max(dot(reflect(rd, nf), SD), 0.), 2600.)*exp(-(f.x*f.x*size*.3 + f.y*f.y*size))*mix(.5, 1.6, r3.y);   // short sideways streaks
}
vec2 toUv(vec3 d, float asp){ return vec2(d.x/d.z*1.55/asp + .5, d.y/d.z*1.55 + uHz); }
vec3 sea(vec3 rd, vec2 uv, float asp){
  float t = min(1./max(-rd.y, 1e-4), FAR);
  vec2 p = rd.xz*t + vec2(uCam.x, uCam.y*.35);
  /* the size of one pixel on the water, from the camera (no fwidth: it is garbage on the horizon row) */
  float dh = max(uHz - uv.y, 1e-4);
  float fp = length(vec2(asp/dh/uRes.x, 1.55/(dh*dh)/uRes.y));
  float near = 1. - smoothstep(.006, .03, fp);           // the fine ripples only where they are bigger than a pixel
  float near2 = 1. - smoothstep(.004, .016, fp);
  float e = max(.012, fp*1.5);
  float h0 = wave(p, near, near2), hx = wave(p + vec2(e, 0.), near, near2), hz = wave(p + vec2(0., e), near, near2);
  float k = 1.55/(1. + t*.06)*(1. + 1.1*near2);   // the near ripples tilt more, so they catch the bright sky low down
  vec3 n = normalize(vec3(-(hx - h0)/e*k, 1., -(hz - h0)/e*k));
  vec3 rr = reflect(rd, n); rr.y = max(rr.y, -rd.y*.5);   // nothing below the horizon to reflect (a floor that follows the row: no single angle gets stacked into a line)
  float F = .02 + .98*pow(1. - max(dot(-rd, n), 0.), 4.);
  vec3 refl = sky(rr);
  /* the reflected sun eases in just below the horizon, so the far edge of the water stays one clean line */
  float clear = smoothstep(.004, .03, dh);
  float mu0 = max(dot(rr, SD), 0.);
  refl -= uSunC*uDay*(pow(mu0, 180.)*.55 + pow(mu0, 24.)*.22*.7)*(1. - clear);
  /* the sun, once it is up: a soft path, and on it the glitter, each facet flashing as it tilts */
  float mu = max(dot(rr, SD), 0.);
  refl += uSunC*uDay*(pow(mu, 900.)*1.6 + pow(mu, 260.)*.5 + pow(mu, 60.)*.08)*clear*smoothstep(.03, .12, SD.y);   // and only once the sun is clear of the horizon
  if(uDay > 0.){
    /* facets grow with distance (two sizes blended), so far off they are still a pixel or two: the path sparkles
       all the way to the horizon instead of only at our feet */
    float lv = max(0., log2(fp*3.2/.03)), l0 = floor(lv);
    float g = mix(glint(p, rd, n, .03*exp2(l0)), glint(p, rd, n, .03*exp2(l0 + 1.)), lv - l0)
            + .6*glint(p + 7.3, rd, n, .03*exp2(l0));      // a second, offset layer: twice the flecks
    float onPath = smoothstep(.12, .55, pow(mu, 60.));       // the flecks ride inside the sun path, never adrift below it
    /* the glitter waits until the sun is clear of the horizon, and thins out before its flecks would grow
       bigger than a pixel or two far off (one giant fleck under the word reads as a dash) */
    refl += uSunC*uDay*g*8.*onPath*smoothstep(.03, .12, SD.y)*(1. - smoothstep(.08, .3, fp))*clear;
  }
  vec3 body = mix(uCSha, uMid*.8, .35);                     // the water body takes a little of the sky overhead
  vec3 c = mix(body, refl, F);
  /* the far water takes the haze and stays a shade under the sky, less so right at the horizon, where a breath of haze
     meets it: the line stays, the cut goes. by day the water and the sky become one and the line fades with them */
  vec3 hzc = sky(vec3(rd.x, 0., rd.z));
  c = mix(c, hzc*mix(mix(.95, .84, smoothstep(0., .06, dh)), 1., uFoot), (1. - exp(-t*.014))*.6);
  c = mix(c, hzc, (1. - smoothstep(0., .014, dh))*.75);
  return c;
}

vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1./2.4)) - .055, step(.0031308, c)); }
vec3 knee(vec3 c){ return mix(c, .78 + .22*(1. - exp(-(c-.78)/.22)), step(.78, c)); }

void main(){
  float asp = uRes.x/uRes.y;
  vec3 rd = normalize(vec3((vUv.x-.5)*asp, vUv.y-uHz, 1.55));
  SD = normalize(vec3((uSun.x-.5)*asp, uSun.y-uHz, 1.55));

  vec3 col; float sv = 0.;
  if(rd.y >= 0.){
    col = sky(rd);
    sv = smoothstep(.015, .22, rd.y);
  } else {
    col = sea(rd, vUv, asp);
  }

  float vig = smoothstep(.4, 1.2, length((vUv-.5)*vec2(max(asp, 1.)*.62, .85)));
  col *= 1. - .3*vig*uStars;

  /* contrast guard: right around the letters the light is capped at night and lifted by day, only as far as the
     contrast needs. it follows the glyphs (the mask holds the word in red, the small line in green; the word's halo
     is a blurred mip level, the small line's its strokes grown by a ring of taps), so what little it does reads as
     the text's own soft shadow, never as a box behind it */
  vec2 m0 = texture(uMask, vUv).rg;
  float cB = m0.g;
  if(textureLod(uMask, vUv, 3.).g > 0.){
    for(int k=0;k<8;k++){ vec2 o = vec2(cos(float(k)*.7854), sin(float(k)*.7854))*uPx;
      cB = max(cB, max(texture(uMask, vUv + o*2.4).g, .35*texture(uMask, vUv + o*3.8).g)); }
  }
  float gA = smoothstep(.015, .12, max(m0.r, textureLod(uMask, vUv, uGLod.x).r)),
        gB = smoothstep(.05, .3, cB), g = max(gA, gB);
  if(g > 0.){
    float Y = dot(col, vec3(.2126,.7152,.0722));
    bool byl = gB > gA;
    float m = byl ? uGuardMode.y : uGuardMode.x;
    if(m > 0.) col *= mix(1., min(1., (byl ? uCap.y : uCap.x)/max(Y, 1e-4)), g*m);
    else col += max(0., (byl ? uCap.w : uCap.z) - Y)*g*(-m);
  }
  col = toSRGB(knee(max(col, 0.)));
  float wh = max(uWhite, uFoot*smoothstep(.24, .0, vUv.y));
  col = mix(col, uBg, wh);
  o = vec4(col, sv);
}`;

/* the finishing pass, at full resolution: the sky and sea above are soft and render at half size (a quarter of the
   work); this scales them up and adds what must stay sharp: the stars, the one bright star, and the dither */
const FINISH = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene;
uniform vec2 uRes, uStar;
uniform float uPr, uTime, uStars, uVenus, uWhite, uFoot;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float stars(vec2 px){
  float s = 0.;
  for(int k=0;k<2;k++){
    float cell = k==0 ? 29. : 57.;
    vec2 id = floor(px/cell), f = px - id*cell;
    float h = hash12(id*1.37 + float(k)*17.3);
    if(h < .5){
      vec2 pos = (vec2(hash12(id+3.1), hash12(id+9.7))*.8 + .1)*cell;
      float d = length(f-pos);
      float b = pow(hash12(id+5.5), 5.)*.95 + .05;
      float tw = .72 + .28*sin(uTime*(.4 + 1.6*hash12(id+1.3)) + h*60.);
      s += b*tw*exp(-d*d*2.2);
    }
  }
  return s;
}
vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1./2.4)) - .055, step(.0031308, c)); }
vec3 toLin(vec3 c){ return mix(c/12.92, pow((c + .055)/1.055, vec3(2.4)), step(.04045, c)); }
vec3 knee(vec3 c){ return mix(c, .78 + .22*(1. - exp(-(c-.78)/.22)), step(.78, c)); }
void main(){
  vec4 sc = texture(uScene, vUv);
  vec3 col = sc.rgb;
  if(uStars + uVenus > 0.){
    vec2 px = gl_FragCoord.xy/uPr;
    float asp = uRes.x/uRes.y, vig = 1. - .3*uStars*smoothstep(.4, 1.2, length((vUv-.5)*vec2(max(asp, 1.)*.62, .85)));
    vec3 add = vec3(.86,.9,1.)*stars(px)*uStars*.5*sc.a;
    vec2 dv = px - uStar; float r2 = dot(dv, dv);
    add += vec3(1.,.95,.88)*uVenus*(exp(-r2*.9)*1.1 + exp(-r2*.02)*.05)*(.9 + .1*sin(uTime*1.7));
    if(dot(add, add) > 1e-10) col = toSRGB(knee(toLin(col) + add*vig));
  }
  /* triangular dither, one step either way: breaks 8-bit banding without reading as grain */
  float wh = max(uWhite, uFoot*smoothstep(.24, .0, vUv.y));
  col += (hash12(gl_FragCoord.xy + fract(uTime)*91.) + hash12(gl_FragCoord.yx*1.7) - 1.)/255.*(1.-wh);
  o = vec4(col, 1.);
}`;

let gl = null, run = false, rafId = 0, wakeUp = () => {}, mode = 'boot', drawn = 0;
/* hooks the GL path fills in, so the test handle below reaches the live scene */
const live = { step: null, redraw: null, info: () => ({}) };
function wake() { wakeUp(); }

function startGL() {
  const g = cvs.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'default', desynchronized: false });
  if (!g) return fail();
  gl = g;
  let halfOK = false;

  /* a lost context (driver reset, GPU switch, too many tabs) shows the designed still until the GPU comes back.
     the hold keeps its length, so nothing on the page jumps */
  let onLost = () => { mode = 'lost'; DE.classList.add('gllost'); cssDay = true; cssHandoff(); }, onBack = go;
  /* back/forward cache: the page lets go of the GPU when it is put away, and builds it again when it comes back */
  const loseExt = gl.getExtension('WEBGL_lose_context');
  let parked = false, shown = true, lostSeen = false;
  const unpark = () => { parked = false; lostSeen = false; try { loseExt.restoreContext(); } catch (e) { fail(); } };
  cvs.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    if (parked) { lostSeen = true; if (shown) unpark(); return; }
    onLost();
  });
  cvs.addEventListener('webglcontextrestored', () => { try { build(onBack); } catch (e) { fail(); } });
  addEventListener('pagehide', () => {
    if (!gl || gl.isContextLost() || mode === 'nogl') return;
    onLost(); mode = 'parked';
    if (loseExt) { parked = true; shown = false; lostSeen = false; loseExt.loseContext(); }
  });
  addEventListener('pageshow', e => {
    if (parked) { shown = true; if (lostSeen) unpark(); }
    else if (e.persisted && mode === 'parked' && gl && !gl.isContextLost()) onBack.again && onBack.again();
  });

  /* everything that lives on the GPU is made here, and made again if the context comes back */
  function build(done) {
    const pcs = gl.getExtension('KHR_parallel_shader_compile');
    halfOK = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = fs => { const p = gl.createProgram(), v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, v); gl.attachShader(p, f); gl.bindAttribLocation(p, 0, 'aP'); gl.linkProgram(p); p._s = [v, f]; return p; };
    const ps = [prog(SCENE), prog(FINISH)];
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    /* compile off the main thread where the browser allows it, then carry on */
    const ready = () => !pcs || ps.every(p => gl.getProgramParameter(p, pcs.COMPLETION_STATUS_KHR));
    const poll = () => {
      try {
        if (gl.isContextLost()) return;
        if (!ready()) return raf(poll);
        for (const p of ps) if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
          console.warn(gl.getShaderInfoLog(p._s[1]) || gl.getProgramInfoLog(p)); return fail();
        }
        done(...ps);
      } catch (e) { fail(); }
    };
    poll();
  }
  build(go);

  function uniforms(p) { const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); } return u; }

  function go(pSc, pF) {
    const mk = D.createElement('canvas'), mctx = mk.getContext('2d');
    let pScene, pFin, uS, uF, texMask, sc;
    function gpu(b, c) {
      pScene = b; pFin = c; uS = uniforms(b); uF = uniforms(c);
      texMask = gl.createTexture();
      sc = { tex: gl.createTexture(), fb: gl.createFramebuffer() };
    }
    gpu(pSc, pF);
    let gmA = 1, gmB = 1, gmT = 0;
    let W = 0, Hh = 0, MW = 0, MH = 0, SW = 0, SH = 0, pr = 1, scale = 1, cssW = 1, cssH = 1, hz = .44, wb = .56, star = [0, 0];
    const PR_MAX = Math.min(WIN.devicePixelRatio || 1, 1.5);
    const SEA_RES = .5;   // the sky and sea render at this fraction of the canvas; the finishing pass keeps the fine things sharp

    function alloc(t, w, h, rgba) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      if (halfOK) gl.texImage2D(gl.TEXTURE_2D, 0, rgba ? gl.RGBA16F : gl.R16F, w, h, 0, rgba ? gl.RGBA : gl.RED, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);   // defined from the start
    }

    /* the horizon is the page's own --hz, read through a zero-size probe: the text stands above it, apart from it */
    const hzProbe = D.createElement('i');
    hzProbe.setAttribute('aria-hidden', 'true');
    hzProbe.style.cssText = 'position:absolute;left:0;top:var(--hz);width:0;height:0;visibility:hidden;pointer-events:none';
    stage.appendChild(hzProbe);
    /* the letters, drawn where the real <h1> glyphs sit: one Range per character, so kerning and spacing match exactly */
    function drawMask() {
      mk.width = MW; mk.height = MH;
      const cr = cvs.getBoundingClientRect(), sx = MW / cr.width, sy = MH / cr.height;
      mctx.fillStyle = '#000'; mctx.fillRect(0, 0, MW, MH);
      const cs = getComputedStyle(h1), fs = parseFloat(cs.fontSize);
      mctx.font = `${cs.fontWeight} ${fs * sy}px ${cs.fontFamily}`;
      mctx.fillStyle = '#f00'; mctx.textBaseline = 'alphabetic'; mctx.textAlign = 'left';
      const node = h1.firstChild, text = node.textContent, rg = D.createRange();
      /* top of a letter's box to its baseline, read from the page: a zero-size probe sits on the baseline */
      const dropOf = (el, tn) => {
        const pb = D.createElement('i'); pb.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        el.prepend(pb); const b = pb.getBoundingClientRect().bottom; pb.remove();
        rg.setStart(tn, 0); rg.setEnd(tn, 1); return b - rg.getBoundingClientRect().top;
      };
      /* the font's own ascent where the browser reports it; engines without font metrics measure the page instead */
      let asc = mctx.measureText('W').fontBoundingBoxAscent / sy;
      if (!Number.isFinite(asc)) asc = dropOf(h1, node);
      let base = NaN;
      for (let i = 0; i < text.length; i++) {
        rg.setStart(node, i); rg.setEnd(node, i + 1);
        const r = rg.getBoundingClientRect();
        base = r.top - cr.top + asc;
        mctx.fillText(text[i], (r.left - cr.left) * sx, base * sy);
      }
      /* nothing that isn't a number reaches the GPU: keep the last good horizon and baseline instead */
      const wb1 = 1 - base / cr.height;
      const hz1 = 1 - (hzProbe.getBoundingClientRect().top - cr.top) / cr.height;
      if (Number.isFinite(wb1)) wb = wb1;
      if (Number.isFinite(hz1) && hz1 > .05 && hz1 < wb) hz = hz1;
      /* the small line goes in the green channel: it casts no light, the contrast guard just needs its shape */
      const bs = getComputedStyle(byl), bn = byl.firstChild, bt = bn.textContent;
      mctx.font = `${bs.fontWeight} ${parseFloat(bs.fontSize) * sy}px ${bs.fontFamily}`; mctx.fillStyle = '#0f0';
      /* its baseline, read from the page itself, not inferred from font metrics:
         at this size the two disagree by a pixel or so, and the guard has to sit exactly on the letters */
      const drop = dropOf(byl, bn);
      for (let i = 0; i < bt.length; i++) {
        rg.setStart(bn, i); rg.setEnd(bn, i + 1);
        const r = rg.getBoundingClientRect();
        mctx.fillText(bt[i], (r.left - cr.left) * sx, (r.top - cr.top + drop) * sy);
      }
      const x = clamp(.34 / (cr.width / cr.height), .12, .31);
      star = [(.5 + x) * cr.width, (wb + .27) * cr.height]; // css px, measured from the bottom like gl_FragCoord
      gl.bindTexture(gl.TEXTURE_2D, texMask);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, mk);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function resize() {
      cssW = cvs.clientWidth || 1; cssH = cvs.clientHeight || 1;
      if (gl.isContextLost()) return;              // sized again when the context comes back
      pr = PR_MAX * scale;
      W = Math.max(2, Math.round(cssW * pr)); Hh = Math.max(2, Math.round(cssH * pr));
      /* the letter mask: half the full-quality size, whatever the adaptive scale, so the letters stay crisp in it */
      MW = Math.max(2, Math.round(cssW * PR_MAX / 2)); MH = Math.max(2, Math.round(cssH * PR_MAX / 2));
      SW = Math.max(2, Math.round(W * SEA_RES)); SH = Math.max(2, Math.round(Hh * SEA_RES));
      cvs.width = W; cvs.height = Hh;
      alloc(sc, SW, SH, true);
      drawMask();
    }
    resize();
    /* a resize clears the canvas: redraw at once (the still frame too), so no frame ever shows it empty */
    const onSize = () => { const w = cvs.clientWidth, h = cvs.clientHeight; if (Math.abs(w - cssW) > 1 || Math.abs(h - cssH) > 1) {
      resize(); measure(); if (!gl.isContextLost() && mode === 'gl') draw(clock()); wake(); } };
    if ('ResizeObserver' in WIN) new ResizeObserver(onSize).observe(cvs); else addEventListener('resize', onSize, { passive: true });
    /* the web font changes the letters' shapes: redraw the mask, and the still frame too (with motion the loop does it) */
    D.fonts && D.fonts.ready && D.fonts.ready.then(() => { if (!gl.isContextLost() && mode === 'gl') { drawMask(); if (reduced) still(); } measure(); wake(); });

    /* pointer: the sun leans toward the cursor; on touch it follows the finger, then drifts on its own */
    let mx = 0, my = 0, tx = 0, ty = 0, lastInput = -1e9, touching = false;
    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch' && !touching) return;
      tx = clamp(e.clientX / innerWidth * 2 - 1, -1, 1); ty = clamp(1 - e.clientY / innerHeight * 2, -1, 1);
      lastInput = clock(); wake();
    }, { passive: true });
    addEventListener('pointerdown', e => { if (e.pointerType === 'touch') { touching = true; lastInput = clock(); } }, { passive: true });
    addEventListener('pointerup', () => { touching = false; }, { passive: true });
    addEventListener('pointercancel', () => { touching = false; }, { passive: true });

    /* a random start: each visit meets a different stretch of cloud, so different letters catch the light
       (a recorded run starts from one fixed stretch, so every take matches) */
    let time = MANUAL ? 137 : 20 + Math.random() * 400, pS = targetP(), last = 0, born = 0;
    let acc = 0, frames = 0, calm = 0, ceilS = 1.01, ceilT = 0, lastDraw = 0, pace = 60;

    function draw(now) {
      drawn++;
      const p = pS, intro = reduced ? 1 : 1 - (1 - clamp((now - born) / 2800)) ** 3;
      const [zen, mid, hor, band, sunC, cTop, cSha] = palette(reduced ? 0 : p);
      const asp = W / Hh;
      const tall = Math.max(1, .75 / asp);
      const drop = .2 * tall ** .6;                  // well under the sea at first; portrait: a little lower
      const rise = ss(seg(.12, .8, p)) * (.55 + drop - .085 * tall);   // by day it climbs to the same place either way
      /* the sun sits a little right of centre, so its glow and its path on the water are not dead symmetrical */
      const sun = [.5 + .016 / tall + mx * .05, hz - drop + (1 - intro) * -.09 + rise + my * .02];

      gl.bindFramebuffer(gl.FRAMEBUFFER, sc.fb); gl.viewport(0, 0, SW, SH);
      gl.useProgram(pScene);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texMask); gl.uniform1i(uS.uMask, 0);
      gl.uniform2f(uS.uRes, SW, SH); gl.uniform1f(uS.uTime, time); gl.uniform1f(uS.uHz, hz);
      gl.uniform2f(uS.uSun, sun[0], sun[1]);
      gl.uniform2f(uS.uCam, mx * .35, time * .045 + p * 3.2);
      /* guard halo, in css px (a mask texel is 2 / PR_MAX css px): about 10 around the word; the small line's is grown by taps */
      gl.uniform2f(uS.uGLod, Math.log2(10 * PR_MAX / 2), 0); gl.uniform2f(uS.uPx, 1 / cssW, 1 / cssH);
      /* the guard's limits are the contrast limits themselves (word 3:1, byline 4.5:1, a hair of margin), so it only
         ever touches a frame that would fail. it changes sides over ~300 ms, as the text colour does, never in one frame */
      const gk = gmT ? 1 - Math.exp(-Math.max(0, now - gmT) / 90) : 1; gmT = now;
      gmA += ((isDay ? -1 : 1) - gmA) * gk; gmB += ((isDay2 ? -1 : 1) - gmB) * gk;
      gl.uniform4f(uS.uCap, .27, isDusk ? .165 : .148, .13, isDay3 ? .214 : .2); gl.uniform2f(uS.uGuardMode, NOGUARD ? 0 : gmA, NOGUARD ? 0 : gmB);
      const stars = (1 - ss(seg(.04, .3, p))) * (.35 + .65 * intro), white = reduced ? 0 : ss(seg(.8, 1, p)), foot = reduced ? 0 : ss(seg(.48, .66, p));
      gl.uniform1f(uS.uStars, stars);
      gl.uniform1f(uS.uDay, ss(seg(.26, .5, p)) * (1 - ss(seg(.78, .98, p))));
      gl.uniform1f(uS.uWhite, white); gl.uniform1f(uS.uFoot, foot);
      gl.uniform3fv(uS.uZen, zen); gl.uniform3fv(uS.uMid, mid); gl.uniform3fv(uS.uHor, hor); gl.uniform3fv(uS.uBand, band);
      gl.uniform3fv(uS.uSunC, sunC); gl.uniform3fv(uS.uCTop, cTop); gl.uniform3fv(uS.uCSha, cSha); gl.uniform3fv(uS.uBg, BG_SRGB);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      /* finish at full size */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, Hh);
      gl.useProgram(pFin);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sc.tex); gl.uniform1i(uF.uScene, 0);
      gl.uniform2f(uF.uRes, W, Hh); gl.uniform2f(uF.uStar, star[0], star[1]); gl.uniform1f(uF.uPr, pr); gl.uniform1f(uF.uTime, time);
      gl.uniform1f(uF.uStars, stars); gl.uniform1f(uF.uVenus, 1 - ss(seg(.14, .3, p)));
      gl.uniform1f(uF.uWhite, white); gl.uniform1f(uF.uFoot, foot);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* one tick of the scene: clock, easing, theme, pacing, then (maybe) a draw. `every` draws regardless of pacing */
    function step(now, every) {
      const raw = last ? (now - last) / 1000 : 1 / 60, dt = MANUAL ? raw : Math.min(.05, raw); last = now;
      time += dt;
      const pT = targetP();
      pS += (pT - pS) * (1 - Math.exp(-dt * 7));
      if (Math.abs(pT - pS) < 1e-4 || forced !== null) pS = pT;
      /* no pointer for a while (or a phone): a slow drift keeps the light alive */
      const idle = !touching && now - lastInput > 3500;
      const ax = Math.sin(time * .19) * .55 + Math.sin(time * .071) * .3, ay = Math.sin(time * .13 + 1.3) * .4;
      const gx = idle ? ax : tx, gy = idle ? ay : ty, k = 1 - Math.exp(-dt * (idle ? .9 : 3.2));
      mx += (gx - mx) * k; my += (gy - my) * k;
      theme(pS);
      /* pace: never more than 60 draws a second (a 120 Hz screen would otherwise double the work), and 30 once nothing
         is moving but the slow drift, which looks the same at half the rate. clock and easing still tick every frame */
      acc += Math.min(raw, .25); frames++;   // counted every tick: a slow draw shows up as a late next tick, drawn or not
      const still30 = now - born > 3000 && now - lastInput > 1500 && !touching && pS === pT;
      pace = still30 ? 30 : 60;
      if (!every && now - lastDraw < 1000 / pace - 4) return;
      lastDraw = now;
      /* adaptive resolution: hold ~50fps or better (checked every 40 ticks or 0.6 s, whichever comes first).
         it runs before the draw: resizing clears the canvas, and a cleared canvas left undrawn shows as a black frame */
      if (MANUAL || now - born < 1200) { acc = 0; frames = 0; }   // ignore start-up hiccups (compile, font swap)
      else if (frames >= 40 || acc > .6) {
        const avg = acc / frames * 1000; acc = 0; frames = 0;
        if (avg > 20 && scale > .34) { ceilS = scale; ceilT = now; scale = Math.max(.34, scale * (avg > 45 ? .6 : .82)); resize(); calm = 0; }
        else if (avg < 18 && scale < 1) {
          if (now - ceilT > 8000) ceilS = 1.01;            // forget an old struggle and try again
          if (++calm > 4) { const s = Math.min(1, scale * 1.12, ceilS * .97); if (s > scale + .01) { scale = s; resize(); } calm = 0; }
        } else calm = 0;
      }
      draw(now);
      /* the page has taken over: nothing left to draw */
      if (pS >= 1 && pT >= 1) run = false;
    }

    function frame(now) {
      rafId = 0;
      if (!run) return;
      try { step(now, false); } catch (e) { stop(); fail(); return; }
      if (run) rafId = raf(frame);
    }

    let onScreen = true;
    wakeUp = () => {
      if (MANUAL || reduced || mode !== 'gl' || gl.isContextLost()) return;
      if (!run && onScreen && !D.hidden && !(targetP() >= 1 && pS >= 1)) { run = true; last = 0; rafId = rafId || raf(frame); }
    };
    const stop = () => { run = false; if (rafId) caf(rafId); rafId = 0; };
    if ('IntersectionObserver' in WIN) new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; onScreen ? wake() : stop(); }).observe(stage);
    D.addEventListener('visibilitychange', () => D.hidden ? stop() : wake());

    const still = () => { pS = 0; draw(clock()); };
    const onRM = e => {
      reduced = e.matches; measure(); cssDay = reduced || gl.isContextLost(); hero.classList.remove('lit'); cssHandoff();
      if (gl.isContextLost() || mode !== 'gl') return;
      if (reduced) { stop(); still(); } else wake();
    };
    if (mqRM) mqRM.addEventListener ? mqRM.addEventListener('change', onRM) : mqRM.addListener && mqRM.addListener(onRM);

    /* the shader takes over the sky: the first frame draws at once, then the loop runs while the hero is in view */
    const begin = () => {
      mode = 'gl'; DE.classList.remove('gllost');
      cssDay = reduced;  // with motion, the shader carries the handoff; reduced motion keeps the plain fade
      if (!reduced) hero.classList.remove('lit');
      if (reduced) { still(); cssHandoff(); }
      else { draw(clock()); wake(); }
      raf(() => DE.classList.add('gl'));
    };
    onLost = () => { stop(); mode = 'lost'; DE.classList.remove('gl'); DE.classList.add('gllost'); cssDay = true; cssHandoff(); };
    onBack = (...ps) => { gpu(...ps); DE.classList.remove('gllost'); last = 0; measure(); resize(); begin(); };
    onBack.again = () => { DE.classList.remove('gllost'); last = 0; measure(); begin(); };

    live.step = ms => { mclock += ms; if (mode !== 'gl' || gl.isContextLost()) return false; if (reduced) { still(); return true; } step(mclock, true); return true; };
    live.redraw = () => { if (mode !== 'gl' || gl.isContextLost()) return false; if (reduced) still(); else { theme(pS); draw(clock()); } return true; };
    live.snap = p => { pS = reduced ? 0 : p; };
    live.info = () => ({ running: run, onScreen, progress: pS, scale, pace, canvas: [W, Hh], scene: [SW, SH], pr, baseline: wb, horizon: hz });

    born = clock();
    begin();
  }
}

function fail() {
  mode = 'nogl'; run = false; if (rafId) cancelAnimationFrame(rafId); rafId = 0;
  DE.classList.remove('gl'); DE.classList.add('nogl'); cssDay = true; measure(); cssHandoff();
}

/* a small handle for automated checks and frame-exact recording; it changes nothing unless it is called */
WIN.__hero = {
  setProgress(p) {
    forced = p === null || p === undefined ? null : clamp(+p);
    if (forced !== null && live.snap) live.snap(forced);
    cssHandoff();
    if (MANUAL) return;
    if (live.redraw && forced !== null && mode === 'gl' && !run) live.redraw();
    wake();
  },
  frameCount: () => drawn,
  state: () => Object.assign({ mode, reduced, manual: MANUAL, hidden: D.hidden, target: targetP(), forced,
    classes: ['day', 'day2', 'dusk', 'day3', 'lit'].filter(c => hero.classList.contains(c)) }, live.info()),
};
if (MANUAL) WIN.__tick = ms => live.step ? live.step(+ms || 0) : ((mclock += +ms || 0), false);

/* WebGL waits until the word has painted and the page is idle: the text is never gated on the canvas */
const boot = () => { try { startGL(); } catch (e) { fail(); } };
const later = () => ('requestIdleCallback' in WIN) ? requestIdleCallback(boot, { timeout: 1200 }) : setTimeout(boot, 200);
if (D.readyState === 'complete') later(); else addEventListener('load', later, { once: true });
}

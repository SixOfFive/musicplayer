// One-shot helper: derive a remix of the stormy-sea preset with
//   - neon colour cycling on the sky
//   - full RGB inversion driven by the lightning / high-peak envelope
// Reads the original JSON, applies targeted shader edits, and writes a
// new preset file alongside. Leaves the original untouched.

import fs from 'node:fs';
import path from 'node:path';

const presetsDir = path.resolve('node_modules/butterchurn-presets/presets/converted');
const srcName = 'martin - stormy sea (2010 update).json';
const dstName = 'martin + sixoffive - stormy sea (2026 update).json';

const src = fs.readFileSync(path.join(presetsDir, srcName), 'utf8');
const preset = JSON.parse(src);

// ---- Modify the COMP shader -------------------------------------------
//
// Two insertions in the composition shader:
//   1. Before the line that builds `xlat_mutableret1`, compute a
//      time-cycled neon palette (skyNeon). Each channel is a sin wave
//      phase-offset 120° apart, then pow(0.4) to push saturation so
//      the peaks land in the magenta / cyan / lime neighbourhood
//      instead of pastel midtones.
//   2. Multiply the sky term (texture * (1.0 - tmpvar_9)) by skyNeon
//      so only the ABOVE-HORIZON portion gets tinted. Water / horizon
//      glow / rain passthroughs are untouched.
//   3. After `ret = tmpvar_12.xyz;`, blend toward inverted colour
//      driven by q23 (the preset's existing high-peak envelope that
//      fires on transients — what the original used for its lightning
//      brightness kick). clamp(q23*6, 0, 1) makes the inversion
//      saturate well before q23 caps out so strong beats fully
//      invert instead of half-washing.
let comp = preset.comp;

const skyOrig = '(texture (sampler_main, uv_1).xyz * \n    (1.0 - tmpvar_9)\n  )';
const skyNew  = '((texture (sampler_main, uv_1).xyz * \n    (1.0 - tmpvar_9)\n  ) * skyNeon)';

// Inject the skyNeon computation right before xlat_mutableret1 is
// first assigned. We anchor on the tmpvar_11 vec2 init that always
// precedes it — stable landmark in the decompiled output.
const neonDecl = [
  '  vec3 skyNeon;',
  '  float neonT = (time * 0.3);',
  '  skyNeon.x = (0.5 + (0.5 * sin(neonT)));',
  '  skyNeon.y = (0.5 + (0.5 * sin((neonT + 2.0944))));',
  '  skyNeon.z = (0.5 + (0.5 * sin((neonT + 4.1888))));',
  '  skyNeon = pow(skyNeon, vec3(0.4, 0.4, 0.4));',
  '',
].join('\n');

const anchor = '  xlat_mutableret1 = (((texture (sampler_main, uv_1).xyz *';
if (!comp.includes(anchor)) {
  throw new Error('anchor not found in comp shader — upstream preset format may have changed');
}
comp = comp.replace(anchor, neonDecl + anchor);

if (!comp.includes(skyOrig)) {
  throw new Error('sky term not found — shader layout differs from what we expected');
}
comp = comp.replace(skyOrig, skyNew);

// Lightning inverse: inject right after the final `ret = tmpvar_12.xyz;`.
// Matches once and exactly.
const lightningBlock = [
  '  ret = tmpvar_12.xyz;',
  '  float lightningInv = clamp((q23 * 6.0), 0.0, 1.0);',
  '  ret = mix(ret, (vec3(1.0, 1.0, 1.0) - ret), lightningInv);',
].join('\n');
if (!comp.includes('  ret = tmpvar_12.xyz;')) {
  throw new Error('ret = tmpvar_12.xyz; anchor missing from comp');
}
comp = comp.replace('  ret = tmpvar_12.xyz;', lightningBlock);

// ---- Heavier rain: visible diagonal falling streaks ------------------
//
// The original preset already has rain — two noise samples summed,
// modulated by a volume-driven curtain mask, and added to the scene
// at 0.06 intensity. Subtle, easy to miss during casual viewing.
//
// Layer added here: a second rain pass that's *deliberately* visible —
// stretched high-frequency noise so each noise peak becomes a tall
// thin stroke (looks like a raindrop streak), y-advected over time
// so the streaks fall, with a small x component so they angle
// (wind). pow(8.0) sharpens the noise so only the brightest ~5%
// of pixels become visible streaks — the rest is dark sky. Scaled
// by the existing sky mask (1.0 - tmpvar_9) so streaks only appear
// above the horizon; amplitude also rides q20 (volume) so heavier
// moments rain harder.
//
// Injected into xlat_mutableret1 BEFORE the exp tonemap so the
// streaks get compressed into the displayed luminance range
// consistently with the rest of the scene — otherwise they'd look
// like chalk-white lines instead of bright streaks.
const heavyRainBlock = [
  '  vec2 rainStreakUv;',
  '  rainStreakUv.x = ((uv.x * 40.0) + (uv.y * 0.8));',
  '  rainStreakUv.y = ((uv.y * 10.0) + (time * 4.0));',
  '  float rainStreak = texture(sampler_noise_hq, (rainStreakUv * 0.1)).x;',
  '  rainStreak = (pow(rainStreak, 8.0) * 6.0);',
  '  float rainStreakAmount = ((1.0 - tmpvar_9) * (0.4 + (q20 * 0.5)));',
  '  xlat_mutableret1 = (xlat_mutableret1 + vec3(rainStreak * rainStreakAmount));',
  '  vec4 tmpvar_12;',
].join('\n');
if (!comp.includes('  vec4 tmpvar_12;')) {
  throw new Error('tmpvar_12 declaration anchor missing from comp');
}
comp = comp.replace('  vec4 tmpvar_12;', heavyRainBlock);

preset.comp = comp;

// ---- Write new file ---------------------------------------------------
fs.writeFileSync(path.join(presetsDir, dstName), JSON.stringify(preset), 'utf8');
console.log(`wrote: ${path.join(presetsDir, dstName)}`);
console.log(`original untouched: ${path.join(presetsDir, srcName)}`);

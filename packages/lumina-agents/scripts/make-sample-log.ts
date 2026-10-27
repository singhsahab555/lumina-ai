// Generates a long, realistic-looking (synthetic) pump-station shift log for
// the "20 pages -> < 5 KB bundle" demo. Deterministic, so the file is stable.
//   node scripts/make-sample-log.ts > ../../apps/web/public/samples/ps07-shift-log-45d.txt

let state = 0x5eed;
const rand = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const f = (lo: number, hi: number, d = 1) => (lo + rand() * (hi - lo)).toFixed(d);

const operators = ['R. Okafor', 'L. Meyer', 'S. Iyer', 'T. Nakamura', 'J. Alvarez'];
const routine = [
  'Walkdown complete, no leaks observed at P-07A/P-07B seals.',
  'Inlet screen differential nominal, no cleaning required.',
  'Chlorine residual sample taken and logged at outlet.',
  'HMI-07 alarm summary acknowledged, no standing alarms.',
  'Sump level cycling normally, float switches verified.',
  'Generator weekly no-load test run 15 min, OK.',
  'Valve V-07-3 stroked open/close for exercise, OK.',
  'Panel room temperature within range, HVAC running.',
];

const lines: string[] = [
  'NORTH BASIN WATER TREATMENT, PUMP STATION PS-07',
  'SHIFT LOG AND MAINTENANCE RECORD, 2026-09-09 .. 2026-10-23 (SYNTHETIC DEMO DATA)',
  'Assets: P-07A, P-07B (75 kW centrifugal), VFD D-07A/D-07B, HMI-07 (air-gapped OT segment)',
  '',
];

const DAYS = 45;
for (let day = 0; day < DAYS; day++) {
  const date = new Date(Date.UTC(2026, 8, 9 + day)).toISOString().slice(0, 10);
  const incident = day >= DAYS - 4;
  for (const shift of ['06:00', '14:00', '22:00']) {
    lines.push(`[${date} ${shift}] Shift handover, operator ${pick(operators)}.`);
    const vib = day >= DAYS - 7 ? f(4.6, 6.9) : f(1.8, 2.9); // bearing degrading before the trip
    lines.push(
      `  Readings: P-07A flow ${f(410, 455, 0)} m3/h, discharge ${f(5.1, 5.7)} bar, vib ${f(1.6, 2.6)} mm/s, DE bearing ${f(44, 52, 0)} C; ` +
        `P-07B ${incident ? 'standby' : `flow ${f(405, 450, 0)} m3/h, vib ${vib} mm/s, DE bearing ${f(45, 58, 0)} C`}.`,
    );
    for (let i = 0; i < 4; i++) lines.push(`  ${pick(routine)}`);
  }
  if (day === DAYS - 4) {
    lines.push(
      `[${date} 06:40] P-07B drive-end vibration 7.9 mm/s RMS (alarm 7.1, trip 11.0). Bearing temp 71 C (limit 85 C).`,
      `[${date} 07:05] Duty switched to P-07A. P-07B in standby, LOTO tag #4471 applied.`,
    );
  }
  if (day === DAYS - 3) lines.push(`[${date} 09:30] Inspection: coupling misalignment 0.32 mm (tolerance 0.05 mm). Grease discoloured.`);
  if (day === DAYS - 2) {
    lines.push(
      `[${date} 13:15] Laser alignment completed: 0.03 mm offset, 0.02 mm/100 mm angular.`,
      `[${date} 14:00] Bearings regreased, 18 g per bearing.`,
    );
  }
  if (day === DAYS - 1) lines.push(`[${date} 08:00] Test run 30 min at 80% speed: vibration 2.4 mm/s RMS, bearing temp 52 C.`);
  lines.push('');
}

lines.push(
  'WORK ORDER WO-2026-1027 (to be applied on HMI-07):',
  ' 1. Confirm LOTO tag #4471 removed by authorised technician.',
  ' 2. Set VFD D-07B ramp-up time to 12 s (was 6 s).',
  ' 3. Set vibration alarm setpoint to 7.1 mm/s, trip setpoint to 11.0 mm/s.',
  ' 4. Set discharge pressure high limit to 6.2 bar.',
  ' 5. Return P-07B to duty/standby rotation, lead pump P-07A.',
  ' 6. Log first 24 h vibration trend and upload at next maintenance window.',
  '',
  'Signed: Shift Engineer, North Basin WTP',
);

process.stdout.write(lines.join('\n') + '\n');

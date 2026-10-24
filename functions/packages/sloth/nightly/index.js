// Wakes the sloth: tells the Sloth Reads app (on App Platform) to do one slow, steady overnight pass.
// The app answers at once and keeps working, so this function stays tiny and well inside its time limit.
async function main(args) {
  const res = await fetch(`${process.env.APP_URL}/api/cron`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET },
    body: JSON.stringify({ brief: args.brief === true }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`cron ${res.status}`, JSON.stringify(body));
  return { body: { status: res.status, ...body } };
}
exports.main = main;

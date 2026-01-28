module.exports = {
  // This fails, and we've given up trying to make it reliable. For now,
  // it is sufficient to just run your own dev server.
  // server: {
  //   command: 'npm run dev -- --port 5173 --strictPort',
  //   port: 5173,
  //   launchTimeout: 5000,
  //   debug: true,
  // },
  launch: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  browserContext: 'default',
};

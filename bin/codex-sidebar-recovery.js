#!/usr/bin/env node
'use strict';

const { parseArgs, startServer, usage } = require('../src/server');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  await startServer(options);
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  console.error('');
  console.error(usage());
  process.exit(1);
});

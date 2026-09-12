/**
 * electron-builder afterPack hook.
 *
 * The standalone server bundle (resources/app-bundle) needs its own
 * node_modules — that is the entire point of Next's standalone output — but
 * electron-builder's copier refuses to carry a `node_modules` directory
 * through extraResources regardless of the filter, and its own dependency
 * collection packs the WRONG tree (the project's dev dependencies) into
 * app.asar, which we exclude. So the one directory both of them mishandle is
 * copied here, after the pack, straight into the output.
 */
const fs = require('fs');
const path = require('path');

exports.default = function afterPack(context) {
  const src = path.join(context.packager.projectDir, 'app-bundle', 'node_modules');
  const dest = path.join(context.appOutDir, 'resources', 'app-bundle', 'node_modules');
  if (!fs.existsSync(src)) {
    console.warn(`[afterPack] no app-bundle/node_modules at ${src} — run desktop/scripts/build-desktop.js first`);
    return;
  }
  console.log(`[afterPack] copying server node_modules -> ${dest}`);
  fs.cpSync(src, dest, { recursive: true, dereference: false });
};

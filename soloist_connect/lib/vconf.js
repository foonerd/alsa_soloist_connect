'use strict';
// Minimal v-conf-compatible config store: {"key": {"type": "...", "value": ...}}

const fs = require('fs');

class VConf {
  constructor() {
    this.file = null;
    this.data = {};
  }
  loadFile(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      this.data = {};
    }
  }
  get(key) {
    const entry = this.data[key];
    return entry ? entry.value : undefined;
  }
  set(key, value) {
    let type = typeof value;
    if (type !== 'boolean' && type !== 'number') type = 'string';
    this.data[key] = { type, value };
    this.save();
  }
  save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      /* best effort */
    }
  }
}

module.exports = VConf;

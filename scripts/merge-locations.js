#!/usr/bin/env node
/**
 * Merges location data from syrif-task-json-store into the existing LEAGUE_5.full.json.
 *
 * Usage:
 *   node scripts/merge-locations.js
 *
 * Reads:
 *   - generated/league-5-raging-echoes/LEAGUE_5.full.json  (existing scraper output)
 *   - ../syrif-task-json-store/tasks/LEAGUE_5.min.json     (location source)
 *
 * Writes:
 *   - generated/league-5-raging-echoes/LEAGUE_5.full.json  (updated in-place)
 */

const fs = require('fs');
const path = require('path');

const fullPath = path.resolve(__dirname, '../generated/league-5-raging-echoes/LEAGUE_5.full.json');
const syrifPath = path.resolve(__dirname, '../../syrif-task-json-store/tasks/LEAGUE_5.min.json');

const fullTasks = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
const syrifTasks = JSON.parse(fs.readFileSync(syrifPath, 'utf-8'));

// Build location map from syrif data
const locationMap = new Map();
for (const task of syrifTasks) {
    if (task.structId != null && task.location &&
        Number.isFinite(task.location.x) && Number.isFinite(task.location.y)) {
        locationMap.set(task.structId, task.location);
    }
}

// Merge into full tasks
let merged = 0;
for (const task of fullTasks) {
    const loc = locationMap.get(task.structId);
    if (loc) {
        task.location = loc;
        merged++;
    }
}

fs.writeFileSync(fullPath, JSON.stringify(fullTasks, null, 2));
console.log(`Merged ${merged} locations into ${fullTasks.length} tasks`);
console.log(`Output: ${fullPath}`);

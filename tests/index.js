/**
 * Test entry point.
 *
 * `node --test tests/` resolves this directory to this file on recent Node
 * versions (which run explicit positional entries as test files); importing the
 * suites here keeps that exact command working, while `node --test
 * "tests/*.test.js"` and directory auto-discovery still find the same files.
 */

import './llm.test.js';
import './index.test.js';

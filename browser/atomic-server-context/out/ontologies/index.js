"use strict";
/* -----------------------------------
* GENERATED WITH @tomic/cli
* -------------------------------- */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initOntologies = initOntologies;
const lib_1 = require("@tomic/lib");
const learningRust_js_1 = require("./learningRust.js");
function initOntologies() {
    (0, lib_1.registerOntologies)(learningRust_js_1.learningRust);
}
//# sourceMappingURL=index.js.map
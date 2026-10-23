/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { fileURLToPath } from "node:url";

const prism = fileURLToPath(new URL("../src/stubs/prism.ts", import.meta.url));
const unused = fileURLToPath(new URL("../src/stubs/empty.ts", import.meta.url));

/**
 * Oxygen UI ships one bundle that imports MUI X and prismjs, which this page
 * never renders. Both the build and the tests alias them to stubs, from this
 * one list, so the tests run the code the page ships.
 */
export const stubAliases = [
  { find: /^@mui\/x-data-grid$/, replacement: unused },
  { find: /^@mui\/x-date-pickers(\/AdapterDateFns)?$/, replacement: unused },
  { find: /^@mui\/x-tree-view$/, replacement: unused },
  { find: /^prismjs(\/.*)?$/, replacement: prism },
];

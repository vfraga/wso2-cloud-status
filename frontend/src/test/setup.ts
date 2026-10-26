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

import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { forgetPolledState } from "../hooks/usePolled";
import { installMatchMedia } from "./viewport";

// findBy and waitFor wait up to half a test's timeout (vitest.config.ts), so a
// busy machine slows a test down rather than failing it.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
  forgetPolledState();
});

// jsdom has no layout engine; MUI and Popper only need these to exist.
class NoopObserver {
  observe = (): undefined => undefined;
  unobserve = (): undefined => undefined;
  disconnect = (): undefined => undefined;
}
globalThis.ResizeObserver = NoopObserver;
installMatchMedia();
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;

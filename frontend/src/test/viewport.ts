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

/** matchMedia that evaluates min-width queries against window.innerWidth (jsdom: 1024). */
type Listener = () => void;
const mediaListeners = new Set<Listener>();
export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query)?.[1];
      return {
        get matches() {
          return min !== undefined && window.innerWidth >= Number(min);
        },
        media: query,
        addEventListener: (_type: string, listener: Listener) => mediaListeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => mediaListeners.delete(listener),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
        onchange: null,
      };
    },
  });
}

/** Resizes the fake viewport and tells media-query listeners. */
export function setViewportWidth(width: number): void {
  window.innerWidth = width;
  for (const listener of mediaListeners) listener();
}

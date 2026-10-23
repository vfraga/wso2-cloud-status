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

import { useState } from "react";

/**
 * Expanded state that follows `auto` until the user toggles it, and follows it
 * again whenever `auto` changes (a product that degrades opens itself).
 */
export function useAutoExpanded(auto: boolean): [boolean, (next: boolean) => void] {
  const [state, setState] = useState({ auto, expanded: auto });
  if (state.auto !== auto) {
    setState({ auto, expanded: auto });
  }
  const expanded = state.auto === auto ? state.expanded : auto;
  return [
    expanded,
    (next) => {
      setState({ auto, expanded: next });
    },
  ];
}

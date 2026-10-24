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

import { useState, type FocusEvent } from "react";

interface Held {
  auto: boolean;
  expanded: boolean;
  /** The reader opened or closed it. */
  toggled: boolean;
  /** Focus is inside the panel. */
  focused: boolean;
}

/** Handlers for the panel, so the state knows when focus is inside it. */
export interface PanelFocus {
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * Expanded state that opens by itself when `auto` turns true (a product that
 * degrades opens itself) and closes by itself when it turns false, unless the
 * reader has toggled it or focus is inside the panel: a list never collapses
 * under the reader, taking their focus with it.
 */
export function useAutoExpanded(auto: boolean): [boolean, (next: boolean) => void, PanelFocus] {
  const [state, setState] = useState<Held>({
    auto,
    expanded: auto,
    toggled: false,
    focused: false,
  });
  let current = state;
  if (state.auto !== auto) {
    current = {
      ...state,
      auto,
      expanded: auto || (state.expanded && (state.toggled || state.focused)),
    };
    setState(current);
  }
  return [
    current.expanded,
    (next) => {
      setState((s) => ({ ...s, expanded: next, toggled: true }));
    },
    {
      onFocus: () => {
        setState((s) => (s.focused ? s : { ...s, focused: true }));
      },
      onBlur: (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setState((s) => (s.focused ? { ...s, focused: false } : s));
      },
    },
  ];
}

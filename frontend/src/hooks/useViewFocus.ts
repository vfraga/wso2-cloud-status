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

import { createContext, useContext, useEffect, useRef, type RefObject } from "react";

/**
 * Reports that the view's h1 now shows its real content (data or a failure),
 * so Layout can move focus to it after a navigation. Outside Layout it does
 * nothing.
 */
export const ViewFocus = createContext<(heading: HTMLElement | null) => void>(() => undefined);

/**
 * A ref for the view's h1. Once `ready` is true the h1 is reported to Layout,
 * which focuses it when a navigation is waiting for it.
 */
export function useViewHeading<T extends HTMLElement>(ready: boolean): RefObject<T | null> {
  const settle = useContext(ViewFocus);
  const heading = useRef<T>(null);
  useEffect(() => {
    if (ready) settle(heading.current);
  }, [ready, settle]);
  return heading;
}

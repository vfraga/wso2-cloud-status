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

import { trimTrailingSlashes } from "../api/endpoints";
import {
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

/*
 * Two routes do not justify a routing library (and the current react-router
 * requires a newer React than Oxygen UI pins). This is the History API plus
 * a subscription, nothing more.
 */

const NAVIGATE_EVENT = "cs:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

const snapshot = (): string => window.location.pathname;

export function usePathname(): string {
  return useSyncExternalStore(subscribe, snapshot, () => "/");
}

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}

type Route = { name: "home" } | { name: "product"; id: string } | { name: "missing" };

export function matchRoute(pathname: string): Route {
  const path = trimTrailingSlashes(pathname) || "/";
  if (path === "/") return { name: "home" };
  const product = /^\/products\/([a-z0-9-]+)$/.exec(path);
  if (product?.[1]) return { name: "product", id: product[1] };
  return { name: "missing" };
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: string;
  children: ReactNode;
};

/** An anchor that navigates in place on a plain left click and keeps native behaviour otherwise. */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (event.defaultPrevented || event.button !== 0 || modified) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

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

import { trimTrailingSlashes } from "../config";
import {
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

/*
 * Three routes do not justify a routing library (and the current react-router
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

const here = (): string => window.location.pathname + window.location.search;

/** The path and query, "/history?product=moesif"; a string, so React compares it by value. */
function useLocation(): string {
  return useSyncExternalStore(subscribe, here, () => "/");
}

export function usePathname(): string {
  return useLocation().split("?")[0] ?? "/";
}

/** One query parameter of the current address; null when it is absent. */
export function useSearchParam(name: string): string | null {
  const location = useLocation();
  const query = location.indexOf("?");
  return query < 0 ? null : new URLSearchParams(location.slice(query)).get(name);
}

export function navigate(to: string): void {
  if (to === here()) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}

/** Changes the address in place, without a history entry or a scroll: a filter's choice. */
export function replaceLocation(to: string): void {
  if (to === here()) return;
  window.history.replaceState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

type Route =
  { name: "home" } | { name: "product"; id: string } | { name: "history" } | { name: "missing" };

export function matchRoute(pathname: string): Route {
  const path = trimTrailingSlashes(pathname) || "/";
  if (path === "/") return { name: "home" };
  if (path === "/history") return { name: "history" };
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

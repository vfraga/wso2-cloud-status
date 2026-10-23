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

/*
 * Stand-in for the Oxygen UI peers this page never renders (MUI X data grid,
 * date pickers, tree view). Oxygen's bundle is not tree-shakable, so without
 * this they add several hundred kB. Nothing here is reachable at runtime.
 */
export const DataGrid = (): null => null;
export const AdapterDateFns = (): null => null;

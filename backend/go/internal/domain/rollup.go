// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

package domain

// GroupStatus rolls a group's components up with Worst.
func GroupStatus(components []Component) Status {
	statuses := make([]Status, len(components))
	for i, c := range components {
		statuses[i] = c.Status
	}
	return Worst(statuses...)
}

// RegionStatus rolls a region's groups up with Worst.
func RegionStatus(groups []Group) Status {
	statuses := make([]Status, len(groups))
	for i, g := range groups {
		statuses[i] = g.Status
	}
	return Worst(statuses...)
}

// Extent tells how much of a roll-up carries its status: every part of it,
// or only some. A problem is worded by it: a major outage when every part
// is out, a partial one when some are.
type Extent string

// Extents.
const (
	ExtentAll  Extent = "all"
	ExtentSome Extent = "some"
)

// ExtentOf is ExtentAll when there are parts and each has the rolled-up
// status, else ExtentSome: a status raised by an incident that no part
// shows is some.
func ExtentOf(rolled Status, parts ...Status) Extent {
	if len(parts) == 0 {
		return ExtentSome
	}
	for _, s := range parts {
		if s != rolled {
			return ExtentSome
		}
	}
	return ExtentAll
}

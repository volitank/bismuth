// Copyright (c) 2018-2019 Eon S. Jeon <esjeon@hyunmu.am>
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
// THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import IDriverWindow from "../../idriver_window";
import ISurface from "../../isurface";
import KWinSurface from "./kwin_surface";
import Rect from "../../util/rect";
import { toQRect, toRect } from "../../util/kwinutil";
import { clip, matchWords } from "../../util/func";
import IConfig from "../../config";
import Debug from "../../util/debug";

export default class KWinWindow implements IDriverWindow {
  public static generateID(client: KWin.Client) {
    return String(client) + "/" + client.windowId;
  }

  public readonly client: KWin.Client;
  public readonly id: string;

  public get fullScreen(): boolean {
    return this.client.fullScreen;
  }

  public get geometry(): Rect {
    return toRect(this.client.geometry);
  }

  public get shouldIgnore(): boolean {
    const resourceClass = String(this.client.resourceClass);
    const resourceName = String(this.client.resourceName);
    const windowRole = String(this.client.windowRole);
    return (
      this.client.specialWindow ||
      resourceClass === "plasmashell" ||
      this.config.ignoreClass.indexOf(resourceClass) >= 0 ||
      this.config.ignoreClass.indexOf(resourceName) >= 0 ||
      matchWords(this.client.caption, this.config.ignoreTitle) >= 0 ||
      this.config.ignoreRole.indexOf(windowRole) >= 0
    );
  }

  public get shouldFloat(): boolean {
    const resourceClass = String(this.client.resourceClass);
    const resourceName = String(this.client.resourceName);
    return (
      this.client.modal ||
      !this.client.resizeable ||
      (this.config.floatUtility &&
        (this.client.dialog || this.client.splash || this.client.utility)) ||
      this.config.floatingClass.indexOf(resourceClass) >= 0 ||
      this.config.floatingClass.indexOf(resourceName) >= 0 ||
      matchWords(this.client.caption, this.config.floatingTitle) >= 0
    );
  }

  public maximized: boolean;

  public get surface(): ISurface {
    let activity;
    if (this.client.activities.length === 0)
      activity = this.kwinApi.workspace.currentActivity;
    else if (this.client.activities.indexOf(this.kwinApi.workspace.currentActivity) >= 0)
      activity = this.kwinApi.workspace.currentActivity;
    else activity = this.client.activities[0];

    const desktop =
      this.client.desktop >= 0 ? this.client.desktop : this.kwinApi.workspace.currentDesktop;

    return new KWinSurface(this.client.screen, activity, desktop, this.qml.activityInfo, this.kwinApi, this.config);
  }

  public set surface(srf: ISurface) {
    const ksrf = srf as KWinSurface;

    // TODO: setting activity?
    // TODO: setting screen = move to the screen
    if (this.client.desktop !== ksrf.desktop)
      this.client.desktop = ksrf.desktop;
  }

  private noBorderManaged: boolean;
  private noBorderOriginal: boolean;
  private qml: Bismuth.Qml.Main;
  private kwinApi: KWin.Api;
  private config: IConfig;
  private debug: Debug;

  constructor(client: KWin.Client, qml: Bismuth.Qml.Main, kwinApi: KWin.Api, config: IConfig, debug: Debug) {
    this.client = client;
    this.id = KWinWindow.generateID(client);
    this.maximized = false;
    this.noBorderManaged = false;
    this.noBorderOriginal = client.noBorder;
    this.qml = qml;
    this.kwinApi = kwinApi;
    this.config = config;
    this.debug = debug;
  }

  public commit(geometry?: Rect, noBorder?: boolean, keepAbove?: boolean) {
    this.debug.debugObj(() => ["KWinWindow#commit", { geometry, noBorder, keepAbove }]);

    if (this.client.move || this.client.resize) return;

    if (noBorder !== undefined) {
      if (!this.noBorderManaged && noBorder)
        /* Backup border state when transitioning from unmanaged to managed */
        this.noBorderOriginal = this.client.noBorder;
      else if (this.noBorderManaged && !this.client.noBorder)
        /* If border is enabled while in managed mode, remember it.
         * Note that there's no way to know if border is re-disabled in managed mode. */
        this.noBorderOriginal = false;

      if (noBorder)
        /* (Re)entering managed mode: remove border. */
        this.client.noBorder = true;
      else if (this.noBorderManaged)
        /* Exiting managed mode: restore original value. */
        this.client.noBorder = this.noBorderOriginal;

      /* update mode */
      this.noBorderManaged = noBorder;
    }

    if (keepAbove !== undefined) this.client.keepAbove = keepAbove;

    if (geometry !== undefined) {
      geometry = this.adjustGeometry(geometry);
      if (this.config.preventProtrusion) {
        const area = toRect(
          this.kwinApi.workspace.clientArea(
            this.kwinApi.KWin.PlacementArea,
            this.client.screen,
            this.kwinApi.workspace.currentDesktop
          )
        );
        if (!area.includes(geometry)) {
          /* assume windows will extrude only through right and bottom edges */
          const x = geometry.x + Math.min(area.maxX - geometry.maxX, 0);
          const y = geometry.y + Math.min(area.maxY - geometry.maxY, 0);
          geometry = new Rect(x, y, geometry.width, geometry.height);
          geometry = this.adjustGeometry(geometry);
        }
      }
      this.client.geometry = toQRect(geometry);
    }
  }

  public toString(): string {
    /* using a shorthand name to keep debug message tidy */
    return (
      "KWin(" +
      this.client.windowId.toString(16) +
      "." +
      this.client.resourceClass +
      ")"
    );
  }

  public visible(srf: ISurface): boolean {
    const ksrf = srf as KWinSurface;
    return (
      !this.client.minimized &&
      (this.client.desktop === ksrf.desktop ||
        this.client.desktop === -1) /* on all desktop */ &&
      (this.client.activities.length === 0 /* on all activities */ ||
        this.client.activities.indexOf(ksrf.activity) !== -1) &&
      this.client.screen === ksrf.screen
    );
  }

  //#region Private Methods

  /** apply various resize hints to the given geometry */
  private adjustGeometry(geometry: Rect): Rect {
    let width = geometry.width;
    let height = geometry.height;

    /* do not resize fixed-size windows */
    if (!this.client.resizeable) {
      width = this.client.geometry.width;
      height = this.client.geometry.height;
    } else {
      /* respect resize increment */
      if (
        !(
          this.client.basicUnit.width === 1 &&
          this.client.basicUnit.height === 1
        )
      )
        /* NOT free-size */
        [width, height] = this.applyResizeIncrement(geometry);

      /* respect min/max size limit */
      width = clip(width, this.client.minSize.width, this.client.maxSize.width);
      height = clip(
        height,
        this.client.minSize.height,
        this.client.maxSize.height
      );
    }

    return new Rect(geometry.x, geometry.y, width, height);
  }

  private applyResizeIncrement(geom: Rect): [number, number] {
    const unit = this.client.basicUnit;
    const base = this.client.minSize;

    const padWidth = this.client.geometry.width - this.client.clientSize.width;
    const padHeight =
      this.client.geometry.height - this.client.clientSize.height;

    const quotWidth = Math.floor(
      (geom.width - base.width - padWidth) / unit.width
    );
    const quotHeight = Math.floor(
      (geom.height - base.height - padHeight) / unit.height
    );

    const newWidth = base.width + unit.width * quotWidth + padWidth;
    const newHeight = base.height + unit.height * quotHeight + padHeight;

    // debugObj(() => ["applyResizeIncrement", {
    //     // tslint:disable-next-line:object-literal-sort-keys
    //     unit, base, geom,
    //     pad: [padWidth, padHeight].join("x"),
    //     size: [newWidth, newHeight].join("x"),
    // }]);

    return [newWidth, newHeight];
  }

  //#endregion
}

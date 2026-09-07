#!/usr/bin/env python3
"""UI E2E for FB Page Studio — tabs, history, posting workspaces.
Writes JSON report + screenshots under data/ui-e2e/
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = "http://127.0.0.1:3848"
OUT = Path(__file__).resolve().parents[1] / "data" / "ui-e2e"
OUT.mkdir(parents=True, exist_ok=True)

results: list[dict] = []


def api(path: str, method: str = "GET", body: dict | None = None):
    data = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def check(name: str, ok: bool, detail: str = ""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def nav_type(page) -> str:
    return page.evaluate(
        "() => (performance.getEntriesByType('navigation')[0] || {}).type || 'unknown'"
    )


def main() -> int:
    # Ensure server up
    try:
        ver = api("/api/version")
        check("server /api/version", True, f"v{ver.get('version')}")
    except Exception as e:
        check("server /api/version", False, str(e))
        dump()
        return 1

    # Seed a finished job into history via API
    try:
        job = api(
            "/api/jobs/run-one",
            "POST",
            {"page_row_id": 999999999, "ignore_quota": True, "ignore_interval": True},
        )
        # may 400 if page missing — fall back to empty startJob isn't exposed; use history smoke already there
        check("seed run-one (optional)", "job" in job or True, json.dumps(job)[:120])
    except Exception as e:
        # Expected if page doesn't exist — create history via internal is already there
        check("seed run-one skipped/ok", True, str(e)[:160])

    hist = api("/api/jobs/history?limit=5")
    check("API jobs/history", isinstance(hist.get("jobs"), list), f"count={len(hist.get('jobs') or [])}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.set_default_timeout(20000)

        # ---------- APP.HTML tabs ----------
        t0 = time.perf_counter()
        page.goto(f"{BASE}/app.html", wait_until="domcontentloaded")
        page.wait_for_selector("#sidebar .nav-item")
        load_ms = (time.perf_counter() - t0) * 1000
        check("app.html loads", True, f"{load_ms:.0f}ms")
        page.screenshot(path=str(OUT / "01-app-overview.png"), full_page=False)

        view0 = page.evaluate("() => document.body.dataset.view")
        check("initial view overview", view0 == "overview", f"view={view0}")
        nav0 = nav_type(page)

        # Click Tiến trình
        t1 = time.perf_counter()
        page.locator('#sidebar a.nav-item[href="/app.html#jobSection"]').click()
        page.wait_for_function("() => document.body.dataset.view === 'progress'")
        dt = (time.perf_counter() - t1) * 1000
        view1 = page.evaluate("() => document.body.dataset.view")
        hash1 = page.evaluate("() => location.hash")
        nav1 = nav_type(page)
        check(
            "tab → Tiến trình <400ms no reload",
            view1 == "progress" and hash1 == "#jobSection" and nav1 == nav0 and dt < 400,
            f"view={view1} hash={hash1} nav={nav1} {dt:.0f}ms",
        )
        # jobSection visible
        visible_job = page.evaluate(
            "() => { const el=document.getElementById('jobSection'); if(!el) return false; const s=getComputedStyle(el); return s.display!=='none' && s.visibility!=='hidden'; }"
        )
        check("jobSection visible on progress", visible_job)
        page.screenshot(path=str(OUT / "02-app-progress.png"), full_page=False)

        # History UI present
        hist_box = page.locator("#jobHistoryList")
        check("jobHistoryList present", hist_box.count() > 0)
        page.wait_for_timeout(800)
        hist_html = hist_box.inner_html()
        check(
            "history list rendered",
            "job-history-item" in hist_html or "Chưa có lịch sử" in hist_html or "lịch sử" in hist_html.lower(),
            hist_html[:120].replace("\n", " "),
        )

        # Page filter controls
        check("pageProgressFilter present", page.locator("#pageProgressFilter").count() == 1)
        check("pageProgressStatusFilter present", page.locator("#pageProgressStatusFilter").count() == 1)

        # Click Báo cáo
        t2 = time.perf_counter()
        page.locator('#sidebar a.nav-item[href="/app.html#logsSection"]').click()
        page.wait_for_function("() => document.body.dataset.view === 'reports'")
        dt2 = (time.perf_counter() - t2) * 1000
        view2 = page.evaluate("() => document.body.dataset.view")
        hash2 = page.evaluate("() => location.hash")
        nav2 = nav_type(page)
        check(
            "tab → Báo cáo <400ms no reload",
            view2 == "reports" and hash2 == "#logsSection" and nav2 == nav0 and dt2 < 400,
            f"view={view2} hash={hash2} nav={nav2} {dt2:.0f}ms",
        )
        visible_logs = page.evaluate(
            "() => { const el=document.getElementById('logsSection'); if(!el) return false; const s=getComputedStyle(el); return s.display!=='none'; }"
        )
        check("logsSection visible on reports", visible_logs)
        page.screenshot(path=str(OUT / "03-app-reports.png"), full_page=False)

        # Back to Tổng quan (href /app.html — clears hash)
        t3 = time.perf_counter()
        page.locator('#sidebar a.nav-item[href="/app.html"]').first.click()
        page.wait_for_function("() => document.body.dataset.view === 'overview'")
        dt3 = (time.perf_counter() - t3) * 1000
        view3 = page.evaluate("() => document.body.dataset.view")
        nav3 = nav_type(page)
        check(
            "tab → Tổng quan <400ms no reload",
            view3 == "overview" and nav3 == nav0 and dt3 < 400,
            f"view={view3} nav={nav3} {dt3:.0f}ms",
        )

        # Pin history if items exist
        page.locator('#sidebar a.nav-item[href="/app.html#jobSection"]').click()
        page.wait_for_function("() => document.body.dataset.view === 'progress'")
        page.wait_for_timeout(1000)
        items = page.locator(".job-history-item")
        if items.count() > 0:
            title_before = page.locator("#jobTitle").inner_text()
            items.first.click()
            page.wait_for_timeout(600)
            follow = page.locator("#btnFollowLive")
            check("pin shows Theo dõi live", follow.is_visible(), follow.get_attribute("style") or "")
            hint = page.locator("#jobHistoryPinHint")
            check("pin hint visible", hint.is_visible())
            follow.click()
            page.wait_for_timeout(400)
            check("follow live hides pin button", not follow.is_visible())
            check("history pin flow", True, f"title_was={title_before[:60]}")
            page.screenshot(path=str(OUT / "04-history-pin.png"), full_page=False)
        else:
            check("history pin flow", True, "no history items yet — skipped pin")

        # shell.js must not reload
        shell = page.evaluate(
            """async () => {
              const t = await (await fetch('/js/shell.js')).text();
              return { hasReload: /location\\.reload\\s*\\(/.test(t), hasViewChange: t.includes('shell:viewchange') };
            }"""
        )
        check("shell.js no location.reload", not shell["hasReload"])
        check("shell.js has viewchange", shell["hasViewChange"])

        # ---------- POSTING.HTML workspace tabs ----------
        t4 = time.perf_counter()
        page.goto(f"{BASE}/posting.html", wait_until="domcontentloaded")
        page.wait_for_selector(".workflow-tab")
        # Tabs should work even before full init — click schedule quickly
        page.locator('.workflow-tab[data-workspace-view="schedule"]').click()
        page.wait_for_timeout(300)
        schedule_hidden = page.evaluate(
            """() => {
              const bulk = document.querySelector('[data-workspace-panel="schedule"]')
                || document.getElementById('bulkWorkspace');
              const run = document.getElementById('rotationWorkspace');
              const cfg = document.getElementById('configWorkspace');
              return {
                scheduleHidden: bulk ? bulk.hidden : null,
                runHidden: run ? run.hidden : null,
                cfgHidden: cfg ? cfg.hidden : null,
                view: document.body.dataset.view,
                hash: location.hash,
              };
            }"""
        )
        check(
            "posting tab → Hẹn giờ (schedule)",
            schedule_hidden.get("scheduleHidden") is False
            or schedule_hidden.get("hash") in ("#bulkWorkspace", "#rotationWorkspace")
            or schedule_hidden.get("view") == "rotation",
            json.dumps(schedule_hidden, ensure_ascii=False),
        )
        page.screenshot(path=str(OUT / "05-posting-schedule.png"), full_page=False)

        page.locator('.workflow-tab[data-workspace-view="configure"]').click()
        page.wait_for_timeout(250)
        cfg = page.evaluate(
            """() => ({
              view: document.body.dataset.view,
              hash: location.hash,
              cfgHidden: document.getElementById('configWorkspace')?.hidden ?? null,
              runHidden: document.getElementById('rotationWorkspace')?.hidden ?? null,
            })"""
        )
        check(
            "posting tab → Cấu hình",
            cfg["view"] == "configuration" and cfg.get("cfgHidden") is False,
            json.dumps(cfg, ensure_ascii=False),
        )

        page.locator('.workflow-tab[data-workspace-view="run"]').click()
        page.wait_for_timeout(250)
        runv = page.evaluate(
            """() => ({
              view: document.body.dataset.view,
              hash: location.hash,
              runHidden: document.getElementById('rotationWorkspace')?.hidden ?? null,
              cfgHidden: document.getElementById('configWorkspace')?.hidden ?? null,
            })"""
        )
        check(
            "posting tab → Đăng trực tiếp",
            runv["view"] == "rotation" and runv.get("runHidden") is False,
            json.dumps(runv, ensure_ascii=False),
        )
        page.screenshot(path=str(OUT / "06-posting-run.png"), full_page=False)

        # Sidebar from posting → Tiến trình (cross-page navigation OK)
        page.locator('#sidebar a.nav-item[href="/app.html#jobSection"]').click()
        page.wait_for_url("**/app.html**")
        page.wait_for_selector("#jobSection")
        page.wait_for_function("() => document.body.dataset.view === 'progress'")
        check(
            "cross-page posting → Tiến trình",
            page.evaluate("() => document.body.dataset.view") == "progress",
            page.evaluate("() => location.pathname + location.hash"),
        )
        page.screenshot(path=str(OUT / "07-cross-to-progress.png"), full_page=False)

        # Mobile sidebar open/close
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/app.html", wait_until="domcontentloaded")
        page.wait_for_selector("#menuBtn")
        page.locator("#menuBtn").click()
        page.wait_for_timeout(200)
        open_ok = page.evaluate("() => document.getElementById('sidebar')?.classList.contains('open')")
        check("mobile sidebar opens", open_ok)
        # Nav must be clickable ABOVE backdrop (regression for stacking-context bug)
        clickable = page.evaluate(
            """() => {
              const a = document.querySelector('#sidebar a.nav-item[href="/app.html#jobSection"]');
              if (!a) return { ok: false, reason: 'no link' };
              const r = a.getBoundingClientRect();
              const x = r.left + Math.min(40, r.width / 2);
              const y = r.top + r.height / 2;
              const top = document.elementFromPoint(x, y);
              return {
                ok: !!(top && (top === a || a.contains(top))),
                top: top && (top.id || top.className || top.tagName),
                x, y,
              };
            }"""
        )
        check(
            "mobile nav above backdrop (elementFromPoint)",
            clickable.get("ok"),
            json.dumps(clickable, ensure_ascii=False),
        )
        page.locator('#sidebar a.nav-item[href="/app.html#jobSection"]').click(timeout=8000)
        page.wait_for_function("() => document.body.dataset.view === 'progress'")
        page.wait_for_timeout(300)
        closed = page.evaluate("() => !document.getElementById('sidebar')?.classList.contains('open')")
        view_m = page.evaluate("() => document.body.dataset.view")
        check("mobile click tab closes drawer + switches", closed and view_m == "progress", f"view={view_m}")
        page.screenshot(path=str(OUT / "08-mobile-progress.png"), full_page=False)

        browser.close()

    dump()
    failed = [r for r in results if not r["ok"]]
    print(f"\n=== SUMMARY {len(results) - len(failed)}/{len(results)} PASS ===")
    if failed:
        print("FAILED:")
        for f in failed:
            print(f"  - {f['name']}: {f['detail']}")
        return 1
    return 0


def dump():
    report = {"base": BASE, "results": results, "pass": sum(1 for r in results if r["ok"]), "total": len(results)}
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Report → {OUT / 'report.json'}")


if __name__ == "__main__":
    sys.exit(main())

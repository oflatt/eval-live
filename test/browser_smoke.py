"""Check the generated default demo with real Pyodide and browser filtering.

Run the no-argument demo first, install Playwright/Chromium, then execute:
    python test/browser_smoke.py
BROWSER_EXECUTABLE optionally selects an existing Chromium executable.
"""
import os
from pathlib import Path
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    with sync_playwright() as playwright:
        options = {"headless": True}
        if os.environ.get("BROWSER_EXECUTABLE"):
            options["executable_path"] = os.environ["BROWSER_EXECUTABLE"]
        browser = playwright.chromium.launch(**options)
        try:
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            page.goto(Path(os.environ.get("EVAL_LIVE_REPORT", ROOT / "demo/out/paper/index.html")).resolve().as_uri())
            page.wait_for_selector(".graph-display img", timeout=60000)
            summary = page.locator(".computed-container .table-section").filter(
                has=page.locator(".table-title", has_text="Summary"))
            assert summary.locator("tbody tr").count() == 6
            assert page.locator(".graph-btn").count() == 2
            previous = page.locator(".graph-display img").get_attribute("src")
            summary.locator(".sql-filter-input").fill("algorithm = 'set' AND size = 500")
            page.wait_for_function("""() => Array.from(document.querySelectorAll('.raw-container .table-section'))
                .find(el => el.querySelector('.table-title').textContent === 'measurements')
                .querySelector('.row-count').textContent.includes('6/27')""", timeout=15000)
            page.wait_for_function("old => document.querySelector('.graph-display img')?.src && document.querySelector('.graph-display img').src !== old",
                                   arg=previous, timeout=15000)
            assert not errors, errors
            page.get_by_text("Clear all filters", exact=True).click()
            page.wait_for_function("""() => Array.from(document.querySelectorAll('.raw-container .table-section'))
                .find(el => el.querySelector('.table-title').textContent === 'measurements')
                .querySelectorAll('tbody tr').length === 27""", timeout=15000)
            page.wait_for_selector(".graph-display img", timeout=15000)
            sizes = summary.locator(".checkbox-dropdown").filter(has=page.locator("summary", has_text="size (3)"))
            sizes.locator("summary").click()
            sizes.locator("label").filter(has_text="8000").locator("input").uncheck()
            page.wait_for_function("""() => Array.from(document.querySelectorAll('.raw-container .table-section'))
                .find(el => el.querySelector('.table-title').textContent === 'measurements')
                .querySelector('.row-count').textContent.includes('18/27')""", timeout=15000)
            assert summary.locator("tbody tr:visible").count() == 4
            assert summary.locator(".sql-filter-input").input_value() == ""
            sql = summary.locator(".sql-filter-input")
            sql.evaluate("input => window.activeFilterInput = input")
            sql.fill("algorithm = 'set'")
            page.wait_for_function("""() => Array.from(document.querySelectorAll('.raw-container .table-section'))
                .find(el => el.querySelector('.table-title').textContent === 'measurements')
                .querySelector('.row-count').textContent.includes('12/27')""", timeout=15000)
            assert sql.evaluate("input => input === window.activeFilterInput && document.activeElement === input")
            assert not sizes.locator("label").filter(has_text="8000").locator("input").is_checked()
            page.get_by_text("Clear all filters", exact=True).click()
            page.wait_for_selector(".graph-display img", timeout=15000)
            print("Browser: both graphs, typed checkboxes, and filtering across commits passed.")
            check_messages(page)
            check_filter_inputs(page)
            assert not errors, errors
        finally:
            browser.close()


def check_messages(page):
    import diagnostics_report
    from eval_live.render import write_html

    data = {"measurements": [{"run_id": "a", "status": "timed-out", "value": None},
                              {"run_id": "b", "status": "success", "value": 2},
                              {"run_id": "c", "status": "failure", "value": None}]}
    selections = {output.id: {"data": ["a", "b", "c"]} for output in diagnostics_report.reg._outputs}
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "messages.html"
        write_html(path, data, diagnostics_report.reg._outputs, selections,
                   source=Path(diagnostics_report.__file__), title="Computed diagnostics")
        page.goto(path.as_uri())
        warnings = page.locator(".computed-container .table-section").filter(
            has=page.locator(".table-title", has_text="Warnings"))
        errors = page.locator(".computed-container .table-section").filter(
            has=page.locator(".table-title", has_text="Errors"))
        page.wait_for_selector(".graph-display img", timeout=60000)
        warnings.wait_for(timeout=15000)
        assert warnings.locator("tbody tr").count() == 1
        assert errors.locator("tbody tr").count() == 1
        assert page.locator(".raw-container .table-title", has_text="Warnings").count() == 0
        measurements = page.locator(".raw-container .table-section").filter(
            has=page.locator(".table-title", has_text="measurements"))
        measurements.locator(".sql-filter-input").fill("status = 'success'")
        warnings.wait_for(state="detached", timeout=15000)
        errors.wait_for(state="detached", timeout=15000)
        page.get_by_text("Clear all filters", exact=True).click()
        warnings.wait_for(timeout=15000)
        assert warnings.locator("tbody tr").count() == 1
        statuses = page.locator(".computed-container .table-section").filter(
            has=page.locator(".table-title", has_text="Statuses"))
        statuses.locator(".sql-filter-input").fill("status = 'success'")
        warnings.wait_for(state="detached", timeout=15000)
        errors.wait_for(state="detached", timeout=15000)
        assert measurements.locator(".row-count").inner_text() == "(1/3 rows)"
        assert set(data) == {"measurements"}
        print("Browser: warnings and errors deduplicate and follow raw and computed filters.")


def check_filter_inputs(page):
    import filter_report
    import eval_live
    from eval_live.render import write_html

    data = {"samples": [{"run_id": "a", "id": "a", "value": 1},
                        {"run_id": "b", "id": "b", "value": 2}]}
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "filters.html"
        selections = {output.id: {"data": ["a", "b"]} for output in filter_report.reg._outputs}
        write_html(path, data, filter_report.reg._outputs, selections,
                   source=Path(filter_report.__file__))
        page.goto(path.as_uri())
        page.wait_for_selector(".graph-display img", timeout=120000)
        raw = page.locator(".raw-container .table-section").filter(
            has=page.locator(".table-title", has_text="samples"))
        computed = page.locator(".computed-container .table-section").filter(
            has=page.locator(".table-title", has_text="samples"))
        raw.locator(".sql-filter-input").fill("id = 'b'")
        computed.locator(".sql-filter-input").fill("[value] = 'G'")
        page.wait_for_selector(".graph-display img", timeout=15000)
        assert raw.locator(".row-count").inner_text() == "(1/2 rows)"
        assert raw.locator("tbody tr:visible").count() == 1
        assert "b" in raw.locator("tbody tr:visible").inner_text()
        assert computed.locator(".sql-filter-input").input_value() == "[value] = 'G'"
        page.get_by_text("Clear all filters", exact=True).click()
        page.wait_for_selector(".graph-display img", timeout=15000)
        assert raw.locator("tbody tr:visible").count() == 2
        print("Browser: raw input filters, independent table names, and reordered row keys passed.")

        reg = eval_live.Registry()
        reg.table("Unsafe", filter_report.unsafe_number)
        write_html(path, data, reg._outputs, {reg._outputs[0].id: {"data": ["a", "b"]}},
                   source=Path(filter_report.__file__))
        page.goto(path.as_uri())
        page.wait_for_function("() => document.querySelector('.graph-status').textContent.includes('exact range')",
                               timeout=120000)
        assert page.locator(".computed-container tbody tr:visible").count() == 0
        print("Browser: oversized computed integers fail explicitly.")


if __name__ == "__main__":
    main()

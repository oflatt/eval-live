"""Browser fixture: diagnostics follow raw and computed filters."""
import eval_live

reg = eval_live.Registry()


def report_timeouts(data):
    if any(row["status"] == "timed-out" for row in data["measurements"]):
        eval_live.warn("Some treatments timed out")
    if any(row["status"] == "failure" for row in data["measurements"]):
        eval_live.error("Some treatments failed")


def narrow_status(rows, data):
    statuses = {row["status"] for row in rows}
    return {**data, "measurements": [row for row in data["measurements"] if row["status"] in statuses]}


@reg.table("Statuses", interactive_filter=narrow_status)
def statuses(data):
    return [{"status": status} for status in sorted({row["status"] for row in data["measurements"]})]


@reg.table("Counts")
def counts(data):
    report_timeouts(data)
    return [{"requested": len(data["measurements"])}]


@reg.graph("Values")
def values(data):
    import matplotlib.pyplot as plt
    report_timeouts(data)
    fig, ax = plt.subplots()
    ax.plot([row["value"] for row in data["measurements"] if row["status"] == "success"])
    return fig

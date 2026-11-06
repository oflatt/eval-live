"""Small report for browser filtering and numeric-boundary regressions."""
import eval_live

reg = eval_live.Registry()


def keep_first(rows, data):
    selected = data["samples"][:1] if rows else []
    return {**data, "samples": [{key: row[key] for key in reversed(row)} for row in selected]}


@reg.table("samples", interactive_filter=keep_first)
def groups(data):
    return [{"value": "G"}] if data["samples"] else []


@reg.table("Count")
def count(data):
    return [{"count": len(data["samples"])}]


@reg.graph("Sample count")
def plot(data):
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots()
    ax.bar(["samples"], [len(data["samples"])])
    return fig


def unsafe_number(data):
    return [{"value": 2**53 + 1}]

# Assembles the viewer: viewer/beats.json into viewer/template.html, written to viewer/index.html.
#
# Usage: python3 viewer/build_html.py [SOURCE_BASE]
# SOURCE_BASE is where the "In the code" links point. Default: the files on GitHub, opened at
# the line. Pass "../" to point at a local checkout instead.
import sys, os
here = os.path.dirname(os.path.abspath(__file__))
base = sys.argv[1] if len(sys.argv) > 1 else "https://github.com/kkang132/harness-internals/blob/main/"
data = open(os.path.join(here, "beats.json")).read().replace("</", "<\\/")
html = open(os.path.join(here, "template.html")).read().replace("__DATA__", data).replace("__SOURCE_BASE__", base)
# A standalone page (GitHub Pages, or opened from disk) needs its own document skeleton.
head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>[hidden]{display:none!important}body{margin:0}img{max-width:100%}</style>
"""
title_end = html.index("</style>") + len("</style>")
html = head + html[:title_end] + "\n</head>\n<body>\n" + html[title_end:] + "\n</body>\n</html>\n"
open(os.path.join(here, "index.html"), "w").write(html)
print("wrote index.html with SOURCE_BASE =", base)

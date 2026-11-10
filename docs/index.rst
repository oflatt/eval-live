eval-live
=========

eval-live helps a paper evaluation use the same Python figure and table
definitions in the terminal, in paper artifacts, and in an interactive webpage.
It plans benchmark execution from each artifact's data requirements, caches
observations by commit and configuration, and records complete argument and
sample provenance in one flat JSON data file. One ``Registry`` holds both
benchmarks and outputs; graph/table callbacks receive dictionaries of named
tables.

.. toctree::
   :maxdepth: 2

   python-guide
   cli
   api
   data-format
   browser
   development

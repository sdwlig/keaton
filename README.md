# keaton
An easy to use, universally applicable, Merkle-tree-based web cache buster command line tool.  Maps and modifies all file names and references with a content hash.

Usage: recache path path:lib path@
   Build a cache based on a file and directory list.
   Each file on the command line is copied along with every file it references in
     the directories listed.  Appending a @ to a directory causes the entire
     directory to be processed.
   The resulting files, other than the anchors, include a hash in the filename.
   This hash is a Merkel Hash of all of the dependent files.

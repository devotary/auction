#!/bin/sh
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$task_root/publish-auctions"
task_result=$?
printf '\nPress Enter to close… '
read -r task_answer
exit "$task_result"

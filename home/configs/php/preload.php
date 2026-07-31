<?php
// OPcache preload. Runs once when PHP-FPM starts so the autoloader and
// the league/commonmark classes are warm in shared memory across every
// request.
require_once '/vendor/autoload.php';
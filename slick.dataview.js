(function ($) {
  $.extend(true, window, {
    Slick: {
      Data: {
        DataView: DataView,
        Aggregators: {
          Avg: AvgAggregator,
          Min: MinAggregator,
          Max: MaxAggregator,
          Sum: SumAggregator
        }
      }
    }
  });


  /***
   * A sample Model implementation.
   * Provides a filtered view of the underlying data.
   *
   * Relies on the data item having an "id" property uniquely identifying it.
   */
  function DataView(options) {
    var self = this;

    var defaults = {
      groupItemMetadataProvider: null,
      inlineFilters: false
    };


    // private
    var idProperty = "id";  // property holding a unique row id
    var items = [];         // data by index
    var rows = [];          // data by row
    var idxById = {};       // indexes by id
    var rowsById = null;    // rows by id; lazy-calculated
    var filter = null;      // filter function
    var updated = null;     // updated item ids
    var suspend = false;    // suspends the recalculation
    var sortAsc = true;
    var fastSortField;
    var sortComparer;
    var refreshHints = {};
    var prevRefreshHints = {};
    var filterArgs;
    var filteredItems = [];
    var compiledFilter;
    var compiledFilterWithCaching;
    var filterCache = [];

    var module = null;  // The visualizer model

    // grouping
    var groupingInfoDefaults = {
      getter: null,
      formatter: null,
      comparer: function(a, b) {
        return (a.value === b.value ? 0 :
                (a.value > b.value ? 1 : -1)
        );
      },
      predefinedValues: [],
      aggregators: [],
      aggregateEmpty: false,
      aggregateCollapsed: false,
      aggregateChildGroups: false,
      collapsed: false,
      displayTotalsRow: true
    };
    var groupingInfos = [];
    var groups = [];
    var toggledGroupsByLevel = [];
    var groupingDelimiter = ':|:';

    var pagesize = 0;
    var pagenum = 0;
    var totalRows = 0;

    // events
    var onRowCountChanged = new Slick.Event();
    var onRowsChanged = new Slick.Event();
    var onPagingInfoChanged = new Slick.Event();

    options = $.extend(true, {}, defaults, options);

    function setModule(m) {
      module = m;
    }

    function beginUpdate() {
      suspend = true;
    }

    function endUpdate() {
      suspend = false;
      refresh();
    }

    function setRefreshHints(hints) {
      refreshHints = hints;
    }

    function setFilterArgs(args) {
      filterArgs = args;
    }

    function updateIdxById(startingIndex) {
      startingIndex = startingIndex || 0;
      var id;
      for (var i = startingIndex, l = items.length; i < l; i++) {
        id = items[i][idProperty];
        if (id === undefined) {
          throw "Each data element must implement a unique 'id' property";
        }
        idxById[id] = i;
      }
    }

    function ensureIdUniqueness() {
      var id;
      for (var i = 0, l = items.length; i < l; i++) {
        id = items[i][idProperty];
        if (id === undefined || idxById[id] !== i) {
          throw "Each data element must implement a unique 'id' property";
        }
      }
    }

    function getItems() {
      return items;
    }

    function setItems(data, objectIdProperty) {
      if (objectIdProperty !== undefined) {
        idProperty = objectIdProperty;
      }
      items = filteredItems = data;
      idxById = {};
      updateIdxById();
      ensureIdUniqueness();
      refresh();
    }

    function setPagingOptions(args) {
      if (args.pageSize != undefined) {
        pagesize = args.pageSize;
        pagenum = pagesize ? Math.min(pagenum, Math.max(0, Math.ceil(totalRows / pagesize) - 1)) : 0;
      }

      if (args.pageNum != undefined) {
        pagenum = Math.min(args.pageNum, Math.max(0, Math.ceil(totalRows / pagesize) - 1));
      }

      onPagingInfoChanged.notify(getPagingInfo(), null, self);

      refresh();
    }

    function getPagingInfo() {
      var totalPages = pagesize ? Math.max(1, Math.ceil(totalRows / pagesize)) : 1;
      return {pageSize: pagesize, pageNum: pagenum, totalRows: totalRows, totalPages: totalPages, dataView: self};
    }

    function sort(comparer, ascending, map) {
      if(map) {
        var d = new Array(items.length);
        for(var i=0; i<items.length; i++) {
          d[i] = [map(items[i]), items[i]];
        }
        timsort.sort(d, function(a,b) {
          return comparer(a[0], b[0]);
        });

        for(var i=0; i<d.length; i++) {
          items[i] = d[i][1];
        }
      } else {
        timsort.sort(items, comparer);
      }

      if (ascending === false) {
        items.reverse();
      }
      idxById = {};
      updateIdxById();
      refresh();
    }

    function sortBy(comparer, ascending) {
      sortAsc = ascending;
      sortComparer = comparer;
      fastSortField = null;
      if (ascending === false) {
        items.reverse();
      }
      items = _.sortBy(items, comparer);
      if (ascending === false) {
        items.reverse();
      }
      idxById = {};
      updateIdxById();
      refresh();
    }

    /***
     * Provides a workaround for the extremely slow sorting in IE.
     * Does a [lexicographic] sort on a give column by temporarily overriding Object.prototype.toString
     * to return the value of that field and then doing a native Array.sort().
     */
    function fastSort(field, ascending) {
      sortAsc = ascending;
      fastSortField = field;
      sortComparer = null;
      var oldToString = Object.prototype.toString;
      Object.prototype.toString = (typeof field == "function") ? field : function () {
        return this[field]
      };
      // an extra reversal for descending sort keeps the sort stable
      // (assuming a stable native sort implementation, which isn't true in some cases)
      if (ascending === false) {
        items.reverse();
      }
      items.sort();
      Object.prototype.toString = oldToString;
      if (ascending === false) {
        items.reverse();
      }
      idxById = {};
      updateIdxById();
      refresh();
    }

    function reSort() {
      if (sortComparer) {
        sort(sortComparer, sortAsc);
      } else if (fastSortField) {
        fastSort(fastSortField, sortAsc);
      }
    }

    function setFilter(filterFn) {
      filter = filterFn;
      if (options.inlineFilters) {
        compiledFilter = compileFilter();
        compiledFilterWithCaching = compileFilterWithCaching();
      }
      refresh();
    }

    function getGrouping() {
      return groupingInfos;
    }

    function setGrouping(groupingInfo) {
      if (!options.groupItemMetadataProvider) {
        options.groupItemMetadataProvider = new Slick.Data.GroupItemMetadataProvider();
      }

      groups = [];
      toggledGroupsByLevel = [];
      groupingInfo = groupingInfo || [];
      groupingInfos = Array.isArray(groupingInfo) ? groupingInfo : [groupingInfo];

      for (var i = 0; i < groupingInfos.length; i++) {
        var gi = groupingInfos[i] = $.extend(true, {}, groupingInfoDefaults, groupingInfos[i]);
        gi.getterIsAFn = typeof gi.getter === "function";

        // pre-compile accumulator loops
        gi.compiledAccumulators = [];
        var idx = gi.aggregators.length;
        while (idx--) {
          gi.compiledAccumulators[idx] = compileAccumulatorLoop(gi.aggregators[idx]);
        }

        toggledGroupsByLevel[i] = {};
      }

      refresh();
    }

    /**
     * @deprecated Please use {@link setGrouping}.
     */
    function groupBy(valueGetter, valueFormatter, sortComparer) {
      if (valueGetter == null) {
        setGrouping([]);
        return;
      }

      setGrouping({
        getter: valueGetter,
        formatter: valueFormatter,
        comparer: sortComparer
      });
    }

    /**
     * @deprecated Please use {@link setGrouping}.
     */
    function setAggregators(groupAggregators, includeCollapsed) {
      if (!groupingInfos.length) {
        throw new Error("At least one grouping must be specified before calling setAggregators().");
      }

      groupingInfos[0].aggregators = groupAggregators;
      groupingInfos[0].aggregateCollapsed = includeCollapsed;

      setGrouping(groupingInfos);
    }

    function getItemByIdx(i) {
      return items[i];
    }

    function getIdxById(id) {
      return idxById[id];
    }

    function ensureRowsByIdCache() {
      if (!rowsById) {
        rowsById = {};
        for (var i = 0, l = rows.length; i < l; i++) {
          rowsById[rows[i][idProperty]] = i;
        }
      }
    }

    function getRowById(id) {
      ensureRowsByIdCache();
      return rowsById[id];
    }

    function getItemById(id) {
      return items[idxById[id]];
    }

    function mapIdsToRows(idArray) {
      var rows = [];
      ensureRowsByIdCache();
      for (var i = 0; i < idArray.length; i++) {
        var row = rowsById[idArray[i]];
        if (row != null) {
          rows[rows.length] = row;
        }
      }
      return rows;
    }

    function mapRowsToIds(rowArray) {
      var ids = [];
      for (var i = 0; i < rowArray.length; i++) {
        if (rowArray[i] < rows.length) {
          ids[ids.length] = rows[rowArray[i]][idProperty];
        }
      }
      return ids;
    }

    function updateItem(id, item) {
      if (idxById[id] === undefined || id !== item[idProperty]) {
        throw "Invalid or non-matching id";
      }
      items[idxById[id]] = item;
      if (!updated) {
        updated = {};
      }
      updated[id] = true;
      refresh();
    }

    function insertItem(insertBefore, item) {
      items.splice(insertBefore, 0, item);
      updateIdxById(insertBefore);
      refresh();
    }

    function addItem(item) {
      items.push(item);
      updateIdxById(items.length - 1);
      refresh();
    }

    function deleteItem(id) {
      var idx = idxById[id];
      if (idx === undefined) {
        throw "Invalid id";
      }
      delete idxById[id];
      items.splice(idx, 1);
      updateIdxById(idx);
      refresh();
    }

    function getLength() {
      return rows.length;
    }

    function getItem(i) {
      return rows[i];
    }

    function getItemMetadata(i) {
      var item = rows[i];
      if (item === undefined) {
        return null;
      }

      // overrides for grouping rows
      if (item.__group) {
        return options.groupItemMetadataProvider.getGroupRowMetadata(item);
      }

      // overrides for totals rows
      if (item.__groupTotals) {
        return options.groupItemMetadataProvider.getTotalsRowMetadata(item);
      }

      return null;
    }

    function expandCollapseAllGroups(level, collapse) {
      if (level == null) {
        for (var i = 0; i < groupingInfos.length; i++) {
          toggledGroupsByLevel[i] = {};
          groupingInfos[i].collapsed = collapse;
        }
      } else {
        toggledGroupsByLevel[level] = {};
        groupingInfos[level].collapsed = collapse;
      }
      refresh();
    }

    /**
     * @param level {Number} Optional level to collapse.  If not specified, applies to all levels.
     */
    function collapseAllGroups(level) {
      expandCollapseAllGroups(level, true);
    }

    /**
     * @param level {Number} Optional level to expand.  If not specified, applies to all levels.
     */
    function expandAllGroups(level) {
      expandCollapseAllGroups(level, false);
    }

    function expandCollapseGroup(level, groupingKey, collapse) {
      toggledGroupsByLevel[level][groupingKey] = groupingInfos[level].collapsed ^ collapse;
      refresh();
    }

    /**
     * @param varArgs Either a Slick.Group's "groupingKey" property, or a
     *     variable argument list of grouping values denoting a unique path to the row.  For
     *     example, calling collapseGroup('high', '10%') will collapse the '10%' subgroup of
     *     the 'high' group.
     */
    function collapseGroup(varArgs) {
      var args = Array.prototype.slice.call(arguments);
      var arg0 = args[0];
      if (args.length == 1 && arg0.indexOf(groupingDelimiter) != -1) {
        expandCollapseGroup(arg0.split(groupingDelimiter).length - 1, arg0, true);
      } else {
        expandCollapseGroup(args.length - 1, args.join(groupingDelimiter), true);
      }
    }

    /**
     * @param varArgs Either a Slick.Group's "groupingKey" property, or a
     *     variable argument list of grouping values denoting a unique path to the row.  For
     *     example, calling expandGroup('high', '10%') will expand the '10%' subgroup of
     *     the 'high' group.
     */
    function expandGroup(varArgs) {
      var args = Array.prototype.slice.call(arguments);
      var arg0 = args[0];
      if (args.length == 1 && arg0.indexOf(groupingDelimiter) != -1) {
        expandCollapseGroup(arg0.split(groupingDelimiter).length - 1, arg0, false);
      } else {
        expandCollapseGroup(args.length - 1, args.join(groupingDelimiter), false);
      }
    }

    function getGroups() {
      return groups;
    }

    function extractGroups(rows, parentGroup) {
      var group;
      var val;
      var groups = [];
      var groupsByVal = {};
      var r;
      var level = parentGroup ? parentGroup.level + 1 : 0;
      var gi = groupingInfos[level];

      for (var i = 0, l = gi.predefinedValues.length; i < l; i++) {
        val = gi.predefinedValues[i];
        group = groupsByVal[val];
        if (!group) {
          group = new Slick.Group();
          group.value = val;
          group.level = level;
          group.groupingKey = (parentGroup ? parentGroup.groupingKey + groupingDelimiter : '') + val;
          groups[groups.length] = group;
          groupsByVal[val] = group;
        }
      }

      for (var i = 0, l = rows.length; i < l; i++) {
        r = rows[i];
        val = gi.getterIsAFn ? gi.getter(r) : r[gi.getter];
        group = groupsByVal[val];
        if (!group) {
          group = new Slick.Group();
          group.value = val;
          group.level = level;
          group.groupingKey = (parentGroup ? parentGroup.groupingKey + groupingDelimiter : '') + val;
          groups[groups.length] = group;
          groupsByVal[val] = group;
        }

        group.rows[group.count++] = r;
      }

      if (level < groupingInfos.length - 1) {
        for (var i = 0; i < groups.length; i++) {
          group = groups[i];
          group.groups = extractGroups(group.rows, group);
        }
      }

      groups.sort(groupingInfos[level].comparer);

      return groups;
    }

    // TODO:  lazy totals calculation
    function calculateGroupTotals(group) {
      // TODO:  try moving iterating over groups into compiled accumulator
      var gi = groupingInfos[group.level];
      var isLeafLevel = (group.level == groupingInfos.length);
      var totals = new Slick.GroupTotals();
      var agg, idx = gi.aggregators.length;
      while (idx--) {
        agg = gi.aggregators[idx];
        agg.init();
        gi.compiledAccumulators[idx].call(agg,
            (!isLeafLevel && gi.aggregateChildGroups) ? group.groups : group.rows);
        agg.storeResult(totals);
      }
      totals.group = group;
      group.totals = totals;
    }

    function calculateTotals(groups, level) {
      level = level || 0;
      var gi = groupingInfos[level];
      var idx = groups.length, g;
      while (idx--) {
        g = groups[idx];

        if (g.collapsed && !gi.aggregateCollapsed) {
          continue;
        }

        // Do a depth-first aggregation so that parent setGrouping aggregators can access subgroup totals.
        if (g.groups) {
          calculateTotals(g.groups, level + 1);
        }

        if (gi.aggregators.length && (
            gi.aggregateEmpty || g.rows.length || (g.groups && g.groups.length))) {
          calculateGroupTotals(g);
        }
      }
    }

    function finalizeGroups(groups, level) {
      level = level || 0;
      var gi = groupingInfos[level];
      var groupCollapsed = gi.collapsed;
      var toggledGroups = toggledGroupsByLevel[level];
      var idx = groups.length, g;
      while (idx--) {
        g = groups[idx];
        g.collapsed = groupCollapsed ^ toggledGroups[g.groupingKey];
        g.title = gi.formatter ? gi.formatter(g) : g.value;

        if (g.groups) {
          finalizeGroups(g.groups, level + 1);
          // Let the non-leaf setGrouping rows get garbage-collected.
          // They may have been used by aggregates that go over all of the descendants,
          // but at this point they are no longer needed.
          g.rows = [];
        }
      }
    }

    function flattenGroupedRows(groups, level) {
      level = level || 0;
      var gi = groupingInfos[level];
      var groupedRows = [], rows, gl = 0, g;
      for (var i = 0, l = groups.length; i < l; i++) {
        g = groups[i];
        groupedRows[gl++] = g;

        if (!g.collapsed) {
          rows = g.groups ? flattenGroupedRows(g.groups, level + 1) : g.rows;
          for (var j = 0, jj = rows.length; j < jj; j++) {
            groupedRows[gl++] = rows[j];
          }
        }

        if (g.totals && gi.displayTotalsRow && (!g.collapsed || gi.aggregateCollapsed)) {
          groupedRows[gl++] = g.totals;
        }
      }
      return groupedRows;
    }

    function getFunctionInfo(fn) {
      var fnRegex = /^function[^(]*\(([^)]*)\)\s*{([\s\S]*)}$/;
      var matches = fn.toString().match(fnRegex);
      return {
        params: matches[1].split(","),
        body: matches[2]
      };
    }

    function compileAccumulatorLoop(aggregator) {
      var accumulatorInfo = getFunctionInfo(aggregator.accumulate);
      var fn = new Function(
          "_items",
          "for (var " + accumulatorInfo.params[0] + ", _i=0, _il=_items.length; _i<_il; _i++) {" +
          accumulatorInfo.params[0] + " = _items[_i]; " +
          accumulatorInfo.body +
          "}"
      );
      fn.displayName = fn.name = "compiledAccumulatorLoop";
      return fn;
    }

    function compileFilter() {
      var filterInfo = getFunctionInfo(filter);

      var filterPath1 = "{ continue _coreloop; }$1";
      var filterPath2 = "{ _retval[_idx++] = $item$; continue _coreloop; }$1";
      // make some allowances for minification - there's only so far we can go with RegEx
      var filterBody = filterInfo.body
          .replace(/return false\s*([;}]|\}|$)/gi, filterPath1)
          .replace(/return!1([;}]|\}|$)/gi, filterPath1)
          .replace(/return true\s*([;}]|\}|$)/gi, filterPath2)
          .replace(/return!0([;}]|\}|$)/gi, filterPath2)
          .replace(/return ([^;}]+?)\s*([;}]|$)/gi,
              "{ if ($1) { _retval[_idx++] = $item$; }; continue _coreloop; }$2");

      // This preserves the function template code after JS compression,
      // so that replace() commands still work as expected.
      var tpl = [
        //"function(_items, _args) { ",
        "var _retval = [], _idx = 0; ",
        "var $item$, $args$ = _args; ",
        "_coreloop: ",
        "for (var _i = 0, _il = _items.length; _i < _il; _i++) { ",
        "$item$ = _items[_i]; ",
        "$filter$; ",
        "} ",
        "return _retval; "
        //"}"
      ].join("");
      tpl = tpl.replace(/\$filter\$/gi, filterBody);
      tpl = tpl.replace(/\$item\$/gi, filterInfo.params[0]);
      tpl = tpl.replace(/\$args\$/gi, filterInfo.params[1]);

      var fn = new Function("_items,_args", tpl);
      fn.displayName = fn.name = "compiledFilter";
      return fn;
    }

    function compileFilterWithCaching() {
      var filterInfo = getFunctionInfo(filter);

      var filterPath1 = "{ continue _coreloop; }$1";
      var filterPath2 = "{ _cache[_i] = true;_retval[_idx++] = $item$; continue _coreloop; }$1";
      // make some allowances for minification - there's only so far we can go with RegEx
      var filterBody = filterInfo.body
          .replace(/return false\s*([;}]|\}|$)/gi, filterPath1)
          .replace(/return!1([;}]|\}|$)/gi, filterPath1)
          .replace(/return true\s*([;}]|\}|$)/gi, filterPath2)
          .replace(/return!0([;}]|\}|$)/gi, filterPath2)
          .replace(/return ([^;}]+?)\s*([;}]|$)/gi,
              "{ if ((_cache[_i] = $1)) { _retval[_idx++] = $item$; }; continue _coreloop; }$2");

      // This preserves the function template code after JS compression,
      // so that replace() commands still work as expected.
      var tpl = [
        //"function(_items, _args, _cache) { ",
        "var _retval = [], _idx = 0; ",
        "var $item$, $args$ = _args; ",
        "_coreloop: ",
        "for (var _i = 0, _il = _items.length; _i < _il; _i++) { ",
        "$item$ = _items[_i]; ",
        "if (_cache[_i]) { ",
        "_retval[_idx++] = $item$; ",
        "continue _coreloop; ",
        "} ",
        "$filter$; ",
        "} ",
        "return _retval; "
        //"}"
      ].join("");
      tpl = tpl.replace(/\$filter\$/gi, filterBody);
      tpl = tpl.replace(/\$item\$/gi, filterInfo.params[0]);
      tpl = tpl.replace(/\$args\$/gi, filterInfo.params[1]);

      var fn = new Function("_items,_args,_cache", tpl);
      fn.displayName = fn.name = "compiledFilterWithCaching";
      return fn;
    }

    function uncompiledFilter(items, args) {
      var retval = [], idx = 0;

      for (var i = 0, ii = items.length; i < ii; i++) {
        if (filter(items[i], args)) {
          retval[idx++] = items[i];
        }
      }

      return retval;
    }

    function uncompiledFilterWithCaching(items, args, cache) {
      var retval = [], idx = 0, item;

      for (var i = 0, ii = items.length; i < ii; i++) {
        item = items[i];
        if (cache[i]) {
          retval[idx++] = item;
        } else if (filter(item, args)) {
          retval[idx++] = item;
          cache[i] = true;
        }
      }

      return retval;
    }

    function getFilteredAndPagedItems(items) {
      if (filter) {
        var batchFilter = options.inlineFilters ? compiledFilter : uncompiledFilter;
        var batchFilterWithCaching = options.inlineFilters ? compiledFilterWithCaching : uncompiledFilterWithCaching;

        if (refreshHints.isFilterNarrowing) {
          filteredItems = batchFilter(filteredItems, filterArgs);
        } else if (refreshHints.isFilterExpanding) {
          filteredItems = batchFilterWithCaching(items, filterArgs, filterCache);
        } else if (!refreshHints.isFilterUnchanged) {
          filteredItems = batchFilter(items, filterArgs);
        }
      } else {
        // special case:  if not filtering and not paging, the resulting
        // rows collection needs to be a copy so that changes due to sort
        // can be caught
        filteredItems = pagesize ? items : items.concat();
      }

      // get the current page
      var paged;
      if (pagesize) {
        if (filteredItems.length <= pagenum * pagesize) {
		  if (filteredItems.length === 0) {
			pagenum = 0;
		  } else {
			pagenum = Math.floor((filteredItems.length - 1) / pagesize);
		  }
        }
        paged = filteredItems.slice(pagesize * pagenum, pagesize * pagenum + pagesize);
      } else {
        paged = filteredItems;
      }
      return {totalRows: filteredItems.length, rows: paged};
    }

    function getRowDiffs(rows, newRows) {
      var item, r, eitherIsNonData, diff = [];
      var from = 0, to = newRows.length;

      if (refreshHints && refreshHints.ignoreDiffsBefore) {
        from = Math.max(0,
            Math.min(newRows.length, refreshHints.ignoreDiffsBefore));
      }

      if (refreshHints && refreshHints.ignoreDiffsAfter) {
        to = Math.min(newRows.length,
            Math.max(0, refreshHints.ignoreDiffsAfter));
      }

      for (var i = from, rl = rows.length; i < to; i++) {
        if (i >= rl) {
          diff[diff.length] = i;
        } else {
          item = newRows[i];
          r = rows[i];

          if ((groupingInfos.length && (eitherIsNonData = (item.__nonDataRow) || (r.__nonDataRow)) &&
              item.__group !== r.__group ||
              item.__group && !item.equals(r))
              || (eitherIsNonData &&
                // no good way to compare totals since they are arbitrary DTOs
                // deep object comparison is pretty expensive
                // always considering them 'dirty' seems easier for the time being
              (item.__groupTotals || r.__groupTotals))
              || item[idProperty] != r[idProperty]
              || (updated && updated[item[idProperty]])
          ) {
            diff[diff.length] = i;
          }
        }
      }
      return diff;
    }

    function recalc(_items) {
      rowsById = null;

      if (refreshHints.isFilterNarrowing != prevRefreshHints.isFilterNarrowing ||
          refreshHints.isFilterExpanding != prevRefreshHints.isFilterExpanding) {
        filterCache = [];
      }

      var filteredItems = getFilteredAndPagedItems(_items);
      totalRows = filteredItems.totalRows;
      var newRows = filteredItems.rows;

      groups = [];
      if (groupingInfos.length) {
        groups = extractGroups(newRows);
        if (groups.length) {
          calculateTotals(groups);
          finalizeGroups(groups);
          newRows = flattenGroupedRows(groups);
        }
      }

      var diff = getRowDiffs(rows, newRows);

      rows = newRows;

      return diff;
    }

    function refresh() {
      if (suspend) {
        return;
      }

      var countBefore = rows.length;
      var totalRowsBefore = totalRows;

      var diff = recalc(items, filter); // pass as direct refs to avoid closure perf hit

      // if the current page is no longer valid, go to last page and recalc
      // we suffer a performance penalty here, but the main loop (recalc) remains highly optimized
      if (pagesize && totalRows < pagenum * pagesize) {
        pagenum = Math.max(0, Math.ceil(totalRows / pagesize) - 1);
        diff = recalc(items, filter);
      }

      updated = null;
      prevRefreshHints = refreshHints;
      refreshHints = {};

      if (totalRowsBefore !== totalRows) {
        onPagingInfoChanged.notify(getPagingInfo(), null, self);
      }
      if (countBefore !== rows.length) {
        onRowCountChanged.notify({previous: countBefore, current: rows.length, dataView: self}, null, self);
      }
      if (diff.length > 0) {
        onRowsChanged.notify({rows: diff, dataView: self}, null, self);
      }
    }

    function syncGridSelection(grid, preserveHidden) {
      var self = this;
      var selectedRowIds = self.mapRowsToIds(grid.getSelectedRows());;
      var inHandler;

      function update() {
        if (selectedRowIds.length > 0) {
          inHandler = true;
          var selectedRows = self.mapIdsToRows(selectedRowIds);
          if (!preserveHidden) {
            selectedRowIds = self.mapRowsToIds(selectedRows);
          }
          grid.setSelectedRows(selectedRows);
          inHandler = false;
        }
      }

      grid.onSelectedRowsChanged.subscribe(function(e, args) {
        if (inHandler) { return; }
        selectedRowIds = self.mapRowsToIds(grid.getSelectedRows());
      });

      this.onRowsChanged.subscribe(update);

      this.onRowCountChanged.subscribe(update);
    }

    function syncGridCellCssStyles(grid, key) {
      var hashById;
      var inHandler;

      // since this method can be called after the cell styles have been set,
      // get the existing ones right away
      storeCellCssStyles(grid.getCellCssStyles(key));

      function storeCellCssStyles(hash) {
        hashById = {};
        for (var row in hash) {
          var id = rows[row][idProperty];
          hashById[id] = hash[row];
        }
      }

      function update() {
        if (hashById) {
          inHandler = true;
          ensureRowsByIdCache();
          var newHash = {};
          for (var id in hashById) {
            var row = rowsById[id];
            if (row != undefined) {
              newHash[row] = hashById[id];
            }
          }
          grid.setCellCssStyles(key, newHash);
          inHandler = false;
        }
      }

      grid.onCellCssStylesChanged.subscribe(function(e, args) {
        if (inHandler) { return; }
        if (key != args.key) { return; }
        if (args.hash) {
          storeCellCssStyles(args.hash);
        }
      });

      this.onRowsChanged.subscribe(update);

      this.onRowCountChanged.subscribe(update);
    }

    $.extend(this, {
      // methods
      "setModule": setModule,
      "beginUpdate": beginUpdate,
      "endUpdate": endUpdate,
      "setPagingOptions": setPagingOptions,
      "getPagingInfo": getPagingInfo,
      "getItems": getItems,
      "setItems": setItems,
      "setFilter": setFilter,
      "sort": sort,
      "sortBy": sortBy,
      "fastSort": fastSort,
      "reSort": reSort,
      "setGrouping": setGrouping,
      "getGrouping": getGrouping,
      "groupBy": groupBy,
      "setAggregators": setAggregators,
      "collapseAllGroups": collapseAllGroups,
      "expandAllGroups": expandAllGroups,
      "collapseGroup": collapseGroup,
      "expandGroup": expandGroup,
      "getGroups": getGroups,
      "getIdxById": getIdxById,
      "getRowById": getRowById,
      "getItemById": getItemById,
      "getItemByIdx": getItemByIdx,
      "mapRowsToIds": mapRowsToIds,
      "mapIdsToRows": mapIdsToRows,
      "setRefreshHints": setRefreshHints,
      "setFilterArgs": setFilterArgs,
      "refresh": refresh,
      "updateItem": updateItem,
      "insertItem": insertItem,
      "addItem": addItem,
      "deleteItem": deleteItem,
      "syncGridSelection": syncGridSelection,
      "syncGridCellCssStyles": syncGridCellCssStyles,

      // data provider methods
      "getLength": getLength,
      "getItem": getItem,
      "getItemMetadata": getItemMetadata,

      // events
      "onRowCountChanged": onRowCountChanged,
      "onRowsChanged": onRowsChanged,
      "onPagingInfoChanged": onPagingInfoChanged
    });
  }

  function AvgAggregator(field) {
    this.field_ = field;

    this.init = function () {
      this.count_ = 0;
      this.nonNullCount_ = 0;
      this.sum_ = 0;
    };

    this.accumulate = function (item) {
      var val = item[this.field_];
      this.count_++;
      if (val != null && val !== "" && !isNaN(val)) {
        this.nonNullCount_++;
        this.sum_ += parseFloat(val);
      }
    };

    this.storeResult = function (groupTotals) {
      if (!groupTotals.avg) {
        groupTotals.avg = {};
      }
      if (this.nonNullCount_ != 0) {
        groupTotals.avg[this.field_] = this.sum_ / this.nonNullCount_;
      }
    };
  }

  function MinAggregator(field) {
    this.field_ = field;

    this.init = function () {
      this.min_ = null;
    };

    this.accumulate = function (item) {
      var val = item[this.field_];
      if (val != null && val !== "" && !isNaN(val)) {
        if (this.min_ == null || val < this.min_) {
          this.min_ = val;
        }
      }
    };

    this.storeResult = function (groupTotals) {
      if (!groupTotals.min) {
        groupTotals.min = {};
      }
      groupTotals.min[this.field_] = this.min_;
    }
  }

  function MaxAggregator(field) {
    this.field_ = field;

    this.init = function () {
      this.max_ = null;
    };

    this.accumulate = function (item) {
      var val = item[this.field_];
      if (val != null && val !== "" && !isNaN(val)) {
        if (this.max_ == null || val > this.max_) {
          this.max_ = val;
        }
      }
    };

    this.storeResult = function (groupTotals) {
      if (!groupTotals.max) {
        groupTotals.max = {};
      }
      groupTotals.max[this.field_] = this.max_;
    }
  }

  function SumAggregator(field) {
    this.field_ = field;

    this.init = function () {
      this.sum_ = null;
    };

    this.accumulate = function (item) {
      var val = item[this.field_];
      if (val != null && val !== "" && !isNaN(val)) {
        this.sum_ += parseFloat(val);
      }
    };

    this.storeResult = function (groupTotals) {
      if (!groupTotals.sum) {
        groupTotals.sum = {};
      }
      groupTotals.sum[this.field_] = this.sum_;
    }
  }

  // TODO:  add more built-in aggregators
  // TODO:  merge common aggregators in one to prevent needles iterating

  /****
   * The MIT License
   *
   * Copyright (c) 2015 Marco Ziccardi
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in
   * all copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   * THE SOFTWARE.
   *
   ****/

  var timsort = {};
  initTimsort(timsort);

  function initTimsort(exports) {
    'use strict';

    exports.__esModule = true;
    exports.sort = sort;

    function _classCallCheck(instance, Constructor) {
      if (!(instance instanceof Constructor)) {
        throw new TypeError('Cannot call a class as a function');
      }
    }

    var DEFAULT_MIN_MERGE = 32;

    var DEFAULT_MIN_GALLOPING = 7;

    var DEFAULT_TMP_STORAGE_LENGTH = 256;

    function alphabeticalCompare(a, b) {
      if (a === b) {
        return 0;
      } else {
        var aStr = String(a);
        var bStr = String(b);

        if (aStr === bStr) {
          return 0;
        } else {
          return aStr < bStr ? -1 : 1;
        }
      }
    }

    function minRunLength(n) {
      var r = 0;

      while (n >= DEFAULT_MIN_MERGE) {
        r |= n & 1;
        n >>= 1;
      }

      return n + r;
    }

    function makeAscendingRun(array, lo, hi, compare) {
      var runHi = lo + 1;

      if (runHi === hi) {
        return 1;
      }

      if (compare(array[runHi++], array[lo]) < 0) {
        while (runHi < hi && compare(array[runHi], array[runHi - 1]) < 0) {
          runHi++;
        }

        reverseRun(array, lo, runHi);
      } else {
        while (runHi < hi && compare(array[runHi], array[runHi - 1]) >= 0) {
          runHi++;
        }
      }

      return runHi - lo;
    }

    function reverseRun(array, lo, hi) {
      hi--;

      while (lo < hi) {
        var t = array[lo];
        array[lo++] = array[hi];
        array[hi--] = t;
      }
    }

    function binaryInsertionSort(array, lo, hi, start, compare) {
      if (start === lo) {
        start++;
      }

      for (; start < hi; start++) {
        var pivot = array[start];

        var left = lo;
        var right = start;

        while (left < right) {
          var mid = left + right >>> 1;

          if (compare(pivot, array[mid]) < 0) {
            right = mid;
          } else {
            left = mid + 1;
          }
        }

        var n = start - left;

        switch (n) {
          case 3:
            array[left + 3] = array[left + 2];

          case 2:
            array[left + 2] = array[left + 1];

          case 1:
            array[left + 1] = array[left];
            break;
          default:
            while (n > 0) {
              array[left + n] = array[left + n - 1];
              n--;
            }
        }

        array[left] = pivot;
      }
    }

    function gallopLeft(value, array, start, length, hint, compare) {
      var lastOffset = 0;
      var maxOffset = 0;
      var offset = 1;

      if (compare(value, array[start + hint]) > 0) {
        maxOffset = length - hint;

        while (offset < maxOffset && compare(value, array[start + hint + offset]) > 0) {
          lastOffset = offset;
          offset = (offset << 1) + 1;

          if (offset <= 0) {
            offset = maxOffset;
          }
        }

        if (offset > maxOffset) {
          offset = maxOffset;
        }

        lastOffset += hint;
        offset += hint;
      } else {
        maxOffset = hint + 1;
        while (offset < maxOffset && compare(value, array[start + hint - offset]) <= 0) {
          lastOffset = offset;
          offset = (offset << 1) + 1;

          if (offset <= 0) {
            offset = maxOffset;
          }
        }
        if (offset > maxOffset) {
          offset = maxOffset;
        }

        var tmp = lastOffset;
        lastOffset = hint - offset;
        offset = hint - tmp;
      }

      lastOffset++;
      while (lastOffset < offset) {
        var m = lastOffset + (offset - lastOffset >>> 1);

        if (compare(value, array[start + m]) > 0) {
          lastOffset = m + 1;
        } else {
          offset = m;
        }
      }
      return offset;
    }

    function gallopRight(value, array, start, length, hint, compare) {
      var lastOffset = 0;
      var maxOffset = 0;
      var offset = 1;

      if (compare(value, array[start + hint]) < 0) {
        maxOffset = hint + 1;

        while (offset < maxOffset && compare(value, array[start + hint - offset]) < 0) {
          lastOffset = offset;
          offset = (offset << 1) + 1;

          if (offset <= 0) {
            offset = maxOffset;
          }
        }

        if (offset > maxOffset) {
          offset = maxOffset;
        }

        var tmp = lastOffset;
        lastOffset = hint - offset;
        offset = hint - tmp;
      } else {
        maxOffset = length - hint;

        while (offset < maxOffset && compare(value, array[start + hint + offset]) >= 0) {
          lastOffset = offset;
          offset = (offset << 1) + 1;

          if (offset <= 0) {
            offset = maxOffset;
          }
        }

        if (offset > maxOffset) {
          offset = maxOffset;
        }

        lastOffset += hint;
        offset += hint;
      }

      lastOffset++;

      while (lastOffset < offset) {
        var m = lastOffset + (offset - lastOffset >>> 1);

        if (compare(value, array[start + m]) < 0) {
          offset = m;
        } else {
          lastOffset = m + 1;
        }
      }

      return offset;
    }

    var TimSort = (function () {
      function TimSort(array, compare) {
        _classCallCheck(this, TimSort);

        this.array = null;
        this.compare = null;
        this.minGallop = DEFAULT_MIN_GALLOPING;
        this.length = 0;
        this.tmpStorageLength = DEFAULT_TMP_STORAGE_LENGTH;
        this.stackLength = 0;
        this.runStart = null;
        this.runLength = null;
        this.stackSize = 0;

        this.array = array;
        this.compare = compare;

        this.length = array.length;

        if (this.length < 2 * DEFAULT_TMP_STORAGE_LENGTH) {
          this.tmpStorageLength = this.length >>> 1;
        }

        this.tmp = new Array(this.tmpStorageLength);

        this.stackLength = this.length < 120 ? 5 : this.length < 1542 ? 10 : this.length < 119151 ? 19 : 40;

        this.runStart = new Array(this.stackLength);
        this.runLength = new Array(this.stackLength);
      }

      TimSort.prototype.pushRun = function pushRun(runStart, runLength) {
        this.runStart[this.stackSize] = runStart;
        this.runLength[this.stackSize] = runLength;
        this.stackSize += 1;
      };

      TimSort.prototype.mergeRuns = function mergeRuns() {
        while (this.stackSize > 1) {
          var n = this.stackSize - 2;

          if (n >= 1 && this.runLength[n - 1] <= this.runLength[n] + this.runLength[n + 1] || n >= 2 && this.runLength[n - 2] <= this.runLength[n] + this.runLength[n - 1]) {

            if (this.runLength[n - 1] < this.runLength[n + 1]) {
              n--;
            }
          } else if (this.runLength[n] > this.runLength[n + 1]) {
            break;
          }
          this.mergeAt(n);
        }
      };

      TimSort.prototype.forceMergeRuns = function forceMergeRuns() {
        while (this.stackSize > 1) {
          var n = this.stackSize - 2;

          if (n > 0 && this.runLength[n - 1] < this.runLength[n + 1]) {
            n--;
          }

          this.mergeAt(n);
        }
      };

      TimSort.prototype.mergeAt = function mergeAt(i) {
        var compare = this.compare;
        var array = this.array;

        var start1 = this.runStart[i];
        var length1 = this.runLength[i];
        var start2 = this.runStart[i + 1];
        var length2 = this.runLength[i + 1];

        this.runLength[i] = length1 + length2;

        if (i === this.stackSize - 3) {
          this.runStart[i + 1] = this.runStart[i + 2];
          this.runLength[i + 1] = this.runLength[i + 2];
        }

        this.stackSize--;

        var k = gallopRight(array[start2], array, start1, length1, 0, compare);
        start1 += k;
        length1 -= k;

        if (length1 === 0) {
          return;
        }

        length2 = gallopLeft(array[start1 + length1 - 1], array, start2, length2, length2 - 1, compare);

        if (length2 === 0) {
          return;
        }

        if (length1 <= length2) {
          this.mergeLow(start1, length1, start2, length2);
        } else {
          this.mergeHigh(start1, length1, start2, length2);
        }
      };

      TimSort.prototype.mergeLow = function mergeLow(start1, length1, start2, length2) {

        var compare = this.compare;
        var array = this.array;
        var tmp = this.tmp;
        var i = 0;

        for (i = 0; i < length1; i++) {
          tmp[i] = array[start1 + i];
        }

        var cursor1 = 0;
        var cursor2 = start2;
        var dest = start1;

        array[dest++] = array[cursor2++];

        if (--length2 === 0) {
          for (i = 0; i < length1; i++) {
            array[dest + i] = tmp[cursor1 + i];
          }
          return;
        }

        if (length1 === 1) {
          for (i = 0; i < length2; i++) {
            array[dest + i] = array[cursor2 + i];
          }
          array[dest + length2] = tmp[cursor1];
          return;
        }

        var minGallop = this.minGallop;

        while (true) {
          var count1 = 0;
          var count2 = 0;
          var exit = false;

          do {
            if (compare(array[cursor2], tmp[cursor1]) < 0) {
              array[dest++] = array[cursor2++];
              count2++;
              count1 = 0;

              if (--length2 === 0) {
                exit = true;
                break;
              }
            } else {
              array[dest++] = tmp[cursor1++];
              count1++;
              count2 = 0;
              if (--length1 === 1) {
                exit = true;
                break;
              }
            }
          } while ((count1 | count2) < minGallop);

          if (exit) {
            break;
          }

          do {
            count1 = gallopRight(array[cursor2], tmp, cursor1, length1, 0, compare);

            if (count1 !== 0) {
              for (i = 0; i < count1; i++) {
                array[dest + i] = tmp[cursor1 + i];
              }

              dest += count1;
              cursor1 += count1;
              length1 -= count1;
              if (length1 <= 1) {
                exit = true;
                break;
              }
            }

            array[dest++] = array[cursor2++];

            if (--length2 === 0) {
              exit = true;
              break;
            }

            count2 = gallopLeft(tmp[cursor1], array, cursor2, length2, 0, compare);

            if (count2 !== 0) {
              for (i = 0; i < count2; i++) {
                array[dest + i] = array[cursor2 + i];
              }

              dest += count2;
              cursor2 += count2;
              length2 -= count2;

              if (length2 === 0) {
                exit = true;
                break;
              }
            }
            array[dest++] = tmp[cursor1++];

            if (--length1 === 1) {
              exit = true;
              break;
            }

            minGallop--;
          } while (count1 >= DEFAULT_MIN_GALLOPING || count2 >= DEFAULT_MIN_GALLOPING);

          if (exit) {
            break;
          }

          if (minGallop < 0) {
            minGallop = 0;
          }

          minGallop += 2;
        }

        this.minGallop = minGallop;

        if (minGallop < 1) {
          this.minGallop = 1;
        }

        if (length1 === 1) {
          for (i = 0; i < length2; i++) {
            array[dest + i] = array[cursor2 + i];
          }
          array[dest + length2] = tmp[cursor1];
        } else if (length1 === 0) {
          throw new Error('mergeLow preconditions were not respected');
        } else {
          for (i = 0; i < length1; i++) {
            array[dest + i] = tmp[cursor1 + i];
          }
        }
      };

      TimSort.prototype.mergeHigh = function mergeHigh(start1, length1, start2, length2) {
        var compare = this.compare;
        var array = this.array;
        var tmp = this.tmp;
        var i = 0;

        for (i = 0; i < length2; i++) {
          tmp[i] = array[start2 + i];
        }

        var cursor1 = start1 + length1 - 1;
        var cursor2 = length2 - 1;
        var dest = start2 + length2 - 1;
        var customCursor = 0;
        var customDest = 0;

        array[dest--] = array[cursor1--];

        if (--length1 === 0) {
          customCursor = dest - (length2 - 1);

          for (i = 0; i < length2; i++) {
            array[customCursor + i] = tmp[i];
          }

          return;
        }

        if (length2 === 1) {
          dest -= length1;
          cursor1 -= length1;
          customDest = dest + 1;
          customCursor = cursor1 + 1;

          for (i = length1 - 1; i >= 0; i--) {
            array[customDest + i] = array[customCursor + i];
          }

          array[dest] = tmp[cursor2];
          return;
        }

        var minGallop = this.minGallop;

        while (true) {
          var count1 = 0;
          var count2 = 0;
          var exit = false;

          do {
            if (compare(tmp[cursor2], array[cursor1]) < 0) {
              array[dest--] = array[cursor1--];
              count1++;
              count2 = 0;
              if (--length1 === 0) {
                exit = true;
                break;
              }
            } else {
              array[dest--] = tmp[cursor2--];
              count2++;
              count1 = 0;
              if (--length2 === 1) {
                exit = true;
                break;
              }
            }
          } while ((count1 | count2) < minGallop);

          if (exit) {
            break;
          }

          do {
            count1 = length1 - gallopRight(tmp[cursor2], array, start1, length1, length1 - 1, compare);

            if (count1 !== 0) {
              dest -= count1;
              cursor1 -= count1;
              length1 -= count1;
              customDest = dest + 1;
              customCursor = cursor1 + 1;

              for (i = count1 - 1; i >= 0; i--) {
                array[customDest + i] = array[customCursor + i];
              }

              if (length1 === 0) {
                exit = true;
                break;
              }
            }

            array[dest--] = tmp[cursor2--];

            if (--length2 === 1) {
              exit = true;
              break;
            }

            count2 = length2 - gallopLeft(array[cursor1], tmp, 0, length2, length2 - 1, compare);

            if (count2 !== 0) {
              dest -= count2;
              cursor2 -= count2;
              length2 -= count2;
              customDest = dest + 1;
              customCursor = cursor2 + 1;

              for (i = 0; i < count2; i++) {
                array[customDest + i] = tmp[customCursor + i];
              }

              if (length2 <= 1) {
                exit = true;
                break;
              }
            }

            array[dest--] = array[cursor1--];

            if (--length1 === 0) {
              exit = true;
              break;
            }

            minGallop--;
          } while (count1 >= DEFAULT_MIN_GALLOPING || count2 >= DEFAULT_MIN_GALLOPING);

          if (exit) {
            break;
          }

          if (minGallop < 0) {
            minGallop = 0;
          }

          minGallop += 2;
        }

        this.minGallop = minGallop;

        if (minGallop < 1) {
          this.minGallop = 1;
        }

        if (length2 === 1) {
          dest -= length1;
          cursor1 -= length1;
          customDest = dest + 1;
          customCursor = cursor1 + 1;

          for (i = length1 - 1; i >= 0; i--) {
            array[customDest + i] = array[customCursor + i];
          }

          array[dest] = tmp[cursor2];
        } else if (length2 === 0) {
          throw new Error('mergeHigh preconditions were not respected');
        } else {
          customCursor = dest - (length2 - 1);
          for (i = 0; i < length2; i++) {
            array[customCursor + i] = tmp[i];
          }
        }
      };

      return TimSort;
    })();

    function sort(array, compare, lo, hi) {
      if (!Array.isArray(array)) {
        throw new TypeError('Can only sort arrays');
      }

      if (!compare) {
        compare = alphabeticalCompare;
      } else if (typeof compare !== 'function') {
        hi = lo;
        lo = compare;
        compare = alphabeticalCompare;
      }

      if (!lo) {
        lo = 0;
      }
      if (!hi) {
        hi = array.length;
      }

      var remaining = hi - lo;

      if (remaining < 2) {
        return;
      }

      var runLength = 0;

      if (remaining < DEFAULT_MIN_MERGE) {
        runLength = makeAscendingRun(array, lo, hi, compare);
        binaryInsertionSort(array, lo, hi, lo + runLength, compare);
        return;
      }

      var ts = new TimSort(array, compare);

      var minRun = minRunLength(remaining);

      do {
        runLength = makeAscendingRun(array, lo, hi, compare);
        if (runLength < minRun) {
          var force = remaining;
          if (force > minRun) {
            force = minRun;
          }

          binaryInsertionSort(array, lo, lo + force, lo + runLength, compare);
          runLength = force;
        }

        ts.pushRun(lo, runLength);
        ts.mergeRuns();

        remaining -= runLength;
        lo += runLength;
      } while (remaining !== 0);

      ts.forceMergeRuns();
    }
  }




})(jQuery);

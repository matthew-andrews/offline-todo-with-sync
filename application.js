(function() {
  var host = location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://offline-todo-api.herokuapp.com';

  // Some globals (although they should probably be private) to stop synchronization
  // running twice at the same time
  var synchronizeInProgress = false, willSynchronizePromise;

  // Some global variables (database, references to key UI elements)
  var db, input, ul;

  databaseOpen()
    .then(function() {
      input = document.getElementsByTagName('input')[0];
      ul = document.getElementsByTagName('ul')[0];
      document.body.addEventListener('submit', onSubmit);
      document.body.addEventListener('click', onClick);
    })
    .then(refreshView)
    .then(synchronize)
    .then(function() {
      var source = new EventSource(host+'/todos/stream');
      source.addEventListener('message', function() {
        if (!synchronizeInProgress) {
          synchronize();
        }
      });
    });

  function onClick(e) {

    // We'll assume any element with an ID attribute
    // is a todo item. Don't try this at home!
    if (e.target.hasAttribute('id')) {

      // Note because the id is stored in the DOM, it becomes
      // a string so need to make it an integer again
      databaseTodosGetByLocalId(parseInt(e.target.getAttribute('id'), 10))
        .then(function(todo) {
          todo.deleted = true;
          return databaseTodosPut(todo);
        })
        .then(refreshView)
        .then(synchronize);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    var todo = {
      text: input.value,
      _id: Date.now()
    };
    input.value = '';
    databaseTodosPut(todo)
      .then(refreshView)
      .then(synchronize);
  }

  function renderAllTodos(todos) {
    var html = '';
    todos.forEach(function(todo) {
      html += todoToHtml(todo);
    });
    ul.innerHTML = html;
  }

  function todoToHtml(todo) {
    return '<li><button id="'+todo._id+'">delete</button>'+todo.text+'</li>';
  }

  function refreshView() {
    return databaseTodosGet({ deleted: false })
      .then(renderAllTodos);
  }

  function synchronize() {
    if (synchronizeInProgress) {
      if (!willSynchronizePromise) {
        willSynchronizePromise = new Promise(function(resolve, reject) {
          document.body.addEventListener('synchronized', function onSynchronized() {
            willSynchronizePromise = undefined;
            document.body.removeEventListener('synchronized', onSynchronized);
            resolve();
          });
        }).then(synchronize);
      }
      return willSynchronizePromise;
    }
    synchronizeInProgress = true;
    return Promise.all([serverTodosGet(), databaseTodosGet()])
      .then(function(results) {
        var remoteTodos = results[0].body;
        var localTodos = results[1];

        // Loop through local todos and if they haven't been
        // posted to the server, post them.
        var promises = localTodos.map(function(todo) {

          // Has it been marked for deletion?
          if (todo.deleted) {
            return serverTodosDelete(todo)
              .then(function() {
                return databaseTodosDelete(todo);
              });
          }

          // Otherwise try to update it
          return serverTodosUpdate(todo)

            // Only need to handle the error case (it's probably been deleted)
            .catch(function(res) {
              return serverTodosGet(todo)
                .then(function(res) {
                  if (res.status === 410) return databaseTodosDelete(todo);
              });
            });
        });

        // Go through the todos that came down from the server,
        // we don't already have one, add it to the local db
        promises.concat(remoteTodos.map(function(todo) {
          if (!localTodos.some(function(localTodo) { return localTodo._id === todo._id; })) {
            return databaseTodosPut(todo);
          }
        }));
        return Promise.all(promises);
    }, function(err) {
      console.error(err, "Cannot connect to server");
    })
    .then(function() {
      refreshView();
      synchronizeInProgress = false;
      document.body.dispatchEvent(new Event('synchronized'));
    });
  }

  function databaseOpen() {
    return new Promise(function(resolve, reject) {
      var version = 1;
      var request = indexedDB.open('todos', version);

      // Run migrations if necessary
      request.onupgradeneeded = function(e) {
        db = e.target.result;
        e.target.transaction.onerror = reject;

        var todoStore = db.createObjectStore('todo', { keyPath: '_id' });
      };

      request.onsuccess = function(e) {
        db = e.target.result;
        resolve();
      };
      request.onerror = reject;
    });
  }

  function databaseTodosPut(todo, callback) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.put(todo);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function databaseTodosGetByLocalId(id, callback) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.get(id);
      request.onsuccess = function(e) {
        var result = e.target.result;
        resolve(result);
      };
      request.onerror = reject;
    });
  }

  function databaseTodosGet(query) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');

      // Get everything in the store
      var keyRange = IDBKeyRange.lowerBound(0);
      var cursorRequest = store.openCursor(keyRange);

      // This fires once per row in the store, so for simplicity
      // collect the data in an array (data) and send it pass it
      // in the callback in one go
      var data = [];
      cursorRequest.onsuccess = function(e) {
        var result = e.target.result;

        // If there's data, add it to array
        if (result) {
          if (!query || (query.deleted === true && result.value.deleted) || (query.deleted === false && !result.value.deleted)) {
            data.push(result.value);
          }
          result.continue();

        // Reach the end of the data
        } else {
          resolve(data);
        }
      };
    });
  }

  function databaseTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.delete(todo._id);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function serverTodosUpdate(todo) {
    return new Promise(function(resolve, reject) {
      superagent.put(host+'/todos/'+todo._id)
        .send({ text: todo.text })
        .end(function(res) {
          if (res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosGet(todo) {
    return new Promise(function(resolve, reject) {
      superagent.get(host + '/todos/' + (todo && todo._id ? todo._id : ''))
        .end(function(err, res) {
          if (!err && res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      superagent.del(host+'/todos/'+todo._id)
        .end(function(res) {
          if (res.ok) resolve();
          else reject();
        });
    });
  }

}());

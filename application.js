(function() {
  var host = location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://offline-todo-api.herokuapp.com';

  var request = superagent;
  var synchronizeInProgress = false;
  var synchronizeRequested = false;

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
    .then(synchronize);

  function onClick(e) {

    // We'll assume any element with an ID attribute
    // is a todo item. Don't try this at home!
    if (e.target.hasAttribute('id')) {

      // Note because the id is stored in the DOM, it becomes
      // a string so need to make it an integer again
      databaseTodosGetByLocalId(parseInt(e.target.getAttribute('id'), 10))
        .then(function(todo) {
          todo.deleted = true;
          todo.updated = Date.now();
          return databaseTodosPut(todo);
        })
        .then(refreshView)
        .then(synchronize);
    }
  }

  function renderAllTodos(todos) {
    var html = '';
    todos.forEach(function(todo) {
      html += todoToHtml(todo);
    });
    ul.innerHTML = html;
  }

  function todoToHtml(todo) {
    return '<li><button id="'+todo.localId+'">delete</button>'+todo.text+'</li>';
  }

  function onSubmit(e) {
    e.preventDefault();
    var todo = {
      text: input.value,
      updated: Date.now(),
      remoteId: undefined
    };
    input.value = '';
    databaseTodosPut(todo)
      .then(refreshView)
      .then(synchronize);
  }

  function databaseOpen() {
    return new Promise(function(resolve, reject) {
      var version = 1;
      var request = indexedDB.open('todos', version);

      // Run migrations if necessary
      request.onupgradeneeded = function(e) {
        db = e.target.result;
        e.target.transaction.onerror = reject;

        var todoStore = db.createObjectStore('todo', { keyPath: 'localId', autoIncrement: true });
        todoStore.createIndex('remoteId', 'remoteId', { unique: false });
      };

      request.onsuccess = function(e) {
        db = e.target.result;
        resolve();
      };
      request.onerror = reject;
    });
  }

  function synchronize() {
    if (synchronizeInProgress) {
      synchronizeRequested = true;
    } else {
      synchronizeInProgress = true;
      Promise.all([serverTodosGet(), databaseTodosGet()])
          .then(function(results) {
            var remoteTodos = results[0].body;
            var localTodos = results[1];
            var localTodosRemoteIds = localTodos.map(function(todo) { return todo.remoteId; });

            // Loop through local todos and if they haven't been
            // posted to the server, post them.
            var promises = localTodos.map(function(todo) {

              // If the remote id exists maybe update the text try to update it
              if (todo.remoteId) {

                // Has it been marked for deletion?
                if (todo.deleted) {
                  return serverTodosDelete(todo)
                    .then(function() {
                      return databaseTodosDelete(todo);
                    });
                }

                // Otherwise try to update it
                return serverTodosUpdate(todo)

                  // Only need to handle the error case (probably a conflict)
                  .catch(function(res) {
                    return serverTodosGet(todo)
                      .then(function(res) {
                        return databaseTodosPut({
                          localId: todo.localId,
                          remoteId: todo.remoteId,
                          text: res.body.text,
                          updated: res.body.updated
                        });

                      // Todo has been deleted, delete it locally too
                      }, function(res) {
                        if (res.status === 404) databaseTodosDelete(todo);
                    });
                  });
              }

              // Otherwise create on the remote server & update local id
              return serverTodosAdd(todo)
                .then(function(res) {
                    todo.remoteId = res.text;
                    return databaseTodosPut(todo);
                }, function(res) {
                  if (res.status === 400) return databaseTodosDelete(todo);
                });
            });
            promises.concat(remoteTodos.map(function(todo) {
              var localCopyIndex = localTodosRemoteIds.indexOf(todo._id);

              // We don't have todo, maybe create it?
              if (localCopyIndex === -1) {
                return databaseTodosPut({
                  text: todo.text,
                  remoteId: todo._id,
                  updated: todo.updated,
                }).then(refreshView);
              }
            }));
            return Promise.all(promises);
        }, function(err) {
          console.error(err, "Cannot connect to server");
        })
        .then(function() {
          synchronizeInProgress = false;
          if (synchronizeRequested) {
            synchronizeRequested = false;
            synchronize();
          }
        });
    }
  }

  function refreshView() {
    return databaseTodosGet({ deleted: false })
      .then(renderAllTodos);
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
      var request = store.delete(todo.localId);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function serverTodosAdd(todo) {
    return new Promise(function(resolve, reject) {
      request.post(host+'/todos')
        .send({ text: todo.text, updated: todo.updated })
        .end(function(res) {
          if (res.ok) {
            resolve(res);

          // If the server rejects the todo (eg. blank text) reject it
          } else if (res.status === 400) {
            reject(res);
          }
        });
    });
  }

  function serverTodosUpdate(todo) {
    return new Promise(function(resolve, reject) {
      request.put(host+'/todos/'+todo.remoteId)
        .send({ text: todo.text, updated: todo.updated })
        .end(function(res) {
          if (res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosGet(todo) {
    return new Promise(function(resolve, reject) {
      request.get(host + '/todos/' + (todo && todo.remoteId ? todo.remoteId : ''))
        .end(function(err, res) {
          if (res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      request.del(host+'/todos/'+todo.remoteId)
        .send({ text: todo.text, updated: todo.updated })
        .end(function(res) {
          if (res.ok) resolve();
          else reject();
        });
    });
  }

}());
